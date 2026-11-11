package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.springframework.http.ResponseEntity;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.lang.reflect.RecordComponent;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * A create body that omits a field with a literal {@code @default} binds {@code @default},
 * as PATCH leaves an absent field untouched and as every other port's create shape does. The DTO is a
 * record, which cannot default a component, so the generated create handler fills the absent defaulted
 * fields into the body before binding it. An explicit value, the first member or null included, is kept.
 */
public class SpringCreateDefaultsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private static final String META = """
        { "metadata.root": { "package": "acme::setting", "children": [
          { "object.entity": { "name": "Setting", "children": [
            { "source.rdb": { "@table": "settings" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "field.enum": { "name": "mode", "@values": ["AUTO", "MANUAL"], "@required": true, "@default": "MANUAL" } },
            { "field.enum": { "name": "optMode", "@values": ["AUTO", "MANUAL"], "@default": "MANUAL" } },
            { "field.boolean": { "name": "enabled", "@required": true, "@default": true } },
            { "field.int": { "name": "retries", "@default": 5 } },
            { "field.string": { "name": "label", "@default": "N/A (unknown)" } },
            { "field.string": { "name": "note", "@default": "line one\\nline \\"two\\"" } },
            { "field.string": { "name": "token", "@default": "gen_random_uuid()" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    private Object controller;
    private final AtomicReference<Object> created = new AtomicReference<>();

    private ResponseEntity<?> post(String json) throws Exception {
        if (controller == null) controller = build();
        Method create = controller.getClass().getMethod("create", JsonNode.class);
        return (ResponseEntity<?>) create.invoke(controller, MAPPER.readTree(json));
    }

    private Object component(String name) throws Exception {
        Object dto = created.get();
        for (RecordComponent rc : dto.getClass().getRecordComponents()) {
            if (rc.getName().equals(name)) {
                Object v = rc.getAccessor().invoke(dto);
                return v == null ? null : v.toString();
            }
        }
        throw new AssertionError("no component " + name);
    }

    @Test
    public void aCreateThatOmitsADefaultedFieldBindsItsDefault() throws Exception {
        ResponseEntity<?> res = post("{\"title\":\"t\"}");
        assertEquals(res.getBody() + "", 201, res.getStatusCode().value());
        assertEquals("MANUAL", component("mode"));
        assertEquals("MANUAL", component("optMode"));
        assertEquals("true", component("enabled"));
        assertEquals("5", component("retries"));
    }

    @Test
    public void aStringDefaultIsALiteralUnlessItIsADatabaseExpression() throws Exception {
        ResponseEntity<?> res = post("{\"title\":\"t\"}");
        assertEquals(res.getBody() + "", 201, res.getStatusCode().value());
        // Parentheses alone do not make an expression: the same rule as meta migrate and the other ports.
        assertEquals("N/A (unknown)", component("label"));
        // A newline and quotes in a default are escaped into the generated literal, which compiles.
        assertEquals("line one\nline \"two\"", component("note"));
        // A database expression is the database's to fill, so the handler leaves it absent.
        assertNull(component("token"));
    }

    @Test
    public void anExplicitValueIsKept() throws Exception {
        ResponseEntity<?> res = post("{\"title\":\"t\",\"mode\":\"AUTO\",\"optMode\":null,\"enabled\":false,\"retries\":0}");
        assertEquals(res.getBody() + "", 201, res.getStatusCode().value());
        assertEquals("AUTO", component("mode"));
        assertNull(component("optMode"));
        assertEquals("false", component("enabled"));
        assertEquals("0", component("retries"));
    }

    private Object build() throws Exception {
        return build(META, "create-defaults", "acme.setting.SettingRepository", "acme.setting.SettingController", "create", 0);
    }

    private Object build(String meta, String name, String repoFqn, String controllerFqn, String createMethod, int dtoArg)
            throws Exception {
        Path work = tmp.newFolder("work-" + name).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(work, name, meta);
        Path gen = tmp.newFolder("gen-" + name).toPath();
        for (var g : List.of(new SpringControllerGenerator(), new SpringDtoGenerator(),
                new SpringRepositoryGenerator(), new SpringFilterAllowlistGenerator())) {
            g.setArgs(Map.of("outputDir", gen.toString()));
            g.execute(loader);
        }
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        Path classes = tmp.newFolder("classes-" + name).toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        boolean ok = javac.getTask(null, fm, diags,
            List.of("-classpath", System.getProperty("java.class.path"), "-parameters", "-d", classes.toString()),
            null, fm.getJavaFileObjectsFromFiles(sources)).call();
        assertTrue(diags.getDiagnostics().toString(), ok);
        URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader());
        Class<?> repo = cl.loadClass(repoFqn);
        Object proxy = Proxy.newProxyInstance(cl, new Class<?>[]{ repo }, (p, m, args) -> {
            if (m.getName().equals(createMethod)) { created.set(args[dtoArg]); return args[dtoArg]; }
            throw new UnsupportedOperationException(m.getName());
        });
        ValidatorFactory vf = Validation.buildDefaultValidatorFactory();
        Validator validator = vf.getValidator();
        return cl.loadClass(controllerFqn)
            .getConstructor(repo, ObjectMapper.class, Validator.class).newInstance(proxy, MAPPER, validator);
    }

    // ---- the TPH per-subtype create path -------------------------------------------------

    private static final String TPH_META = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb": { "@table": "auths" } },
            { "field.enum": { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["OPEN", "SHUT"], "@default": "SHUT" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } },
          { "object.entity": { "name": "BridgeAuth", "extends": "acme::auth::Auth", "@discriminatorValue": "Bridge",
            "children": [ { "field.int": { "name": "quantity", "@default": 3 } } ] } },
          { "object.entity": { "name": "CopayAuth", "extends": "acme::auth::Auth", "@discriminatorValue": "Copay",
            "children": [ { "field.int": { "name": "amount" } } ] } }
        ] } }
        """;

    @Test
    public void aTphSubtypeCreateThatOmitsADefaultedFieldBindsItsDefault() throws Exception {
        Object tph = build(TPH_META, "tph", "acme.auth.AuthRepository", "acme.auth.AuthController", "createWithType", 1);
        Method create = tph.getClass().getMethod("createBridge", JsonNode.class);
        ResponseEntity<?> res = (ResponseEntity<?>) create.invoke(tph, MAPPER.readTree("{}"));
        assertEquals(res.getBody() + "", 201, res.getStatusCode().value());
        assertEquals("SHUT", component("status"));
        assertEquals("3", component("quantity"));
    }
}
