package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.config.ApiSettings;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.springframework.http.ResponseEntity;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * {@code api.unknownFields}: a generated create, PUT and PATCH answers an undeclared body key the same
 * way whatever the host's {@code ObjectMapper} does with an unknown property. The keys are read off
 * the raw body before it is bound, so a mapper with {@code FAIL_ON_UNKNOWN_PROPERTIES} on and one
 * with it off give identical answers under both {@code reject} and {@code drop}.
 */
public class SpringUnknownFieldsCompileRunTest {

    private static final ObjectMapper PLAIN = new ObjectMapper();

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private static ObjectMapper mapper(boolean failOnUnknown) {
        return new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, failOnUnknown);
    }

    private static final String META = """
        { "metadata.root": { "package": "acme::thing", "children": [
          { "object.entity": { "name": "Thing", "children": [
            { "source.rdb": { "@table": "things" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "field.string": { "name": "role", "@mutability": "readOnly" } },
            { "field.timestamp": { "name": "stamped", "@autoSet": "onCreate" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } },
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb": { "@table": "auths" } },
            { "field.enum": { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } },
          { "object.entity": { "name": "BridgeAuth", "extends": "acme::thing::Auth", "@discriminatorValue": "Bridge",
            "children": [ { "field.int": { "name": "quantity" } } ] } },
          { "object.entity": { "name": "CopayAuth", "extends": "acme::thing::Auth", "@discriminatorValue": "Copay",
            "children": [ { "field.string": { "name": "approver" } } ] } }
        ] } }
        """;

    /** One generated, compiled controller pair built for a given {@code api.unknownFields} setting. */
    private final class Built {
        final URLClassLoader cl;
        final Class<?> thingRepo;
        final Class<?> authRepo;
        final List<String> writes = new ArrayList<>();

        Built(ApiSettings api, String name) throws Exception {
            Path work = tmp.newFolder("work-" + name).toPath();
            MetaDataLoader loader = SpringTestFixtures.loadFixture(work, name, META);
            loader.getRoot().setApiSettings(api);
            Path gen = tmp.newFolder("gen-" + name).toPath();
            for (var g : List.of(new SpringControllerGenerator(), new SpringDtoGenerator(),
                    new SpringRepositoryGenerator(), new SpringFilterAllowlistGenerator())) {
                g.setArgs(Map.of("outputDir", gen.toString()));
                g.execute(loader);
            }
            Path classes = tmp.newFolder("classes-" + name).toPath();
            SpringTestFixtures.compileGenerated(gen, classes);
            cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader());
            thingRepo = cl.loadClass("acme.thing.ThingRepository");
            authRepo = cl.loadClass("acme.thing.AuthRepository");
        }

        Object controller(String simple, Class<?> repoType, ObjectMapper mapper) throws Exception {
            Object repo = Proxy.newProxyInstance(cl, new Class<?>[]{ repoType }, (p, m, args) -> {
                if (m.getName().startsWith("create") || m.getName().startsWith("patch")) {
                    writes.add(m.getName());
                    return m.getName().startsWith("patch") ? Optional.empty() : args[args.length - 1];
                }
                throw new UnsupportedOperationException(m.getName());
            });
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
            return cl.loadClass("acme.thing." + simple)
                .getConstructor(repoType, ObjectMapper.class, Validator.class).newInstance(repo, mapper, validator);
        }
    }

    /** The answer of one handler: its status and, for a 400, its body. */
    private static String answer(Object controller, ObjectMapper host, String handler, String json) throws Exception {
        JsonNode body = PLAIN.readTree(json);
        for (Method m : controller.getClass().getMethods()) {
            if (!m.getName().equals(handler)) continue;
            // Under drop a create still binds the DTO directly: do that with the host's own mapper,
            // as Spring's message converter would.
            Class<?> bodyType = m.getParameterTypes()[m.getParameterCount() - 1];
            Object bound = bodyType == JsonNode.class ? body : host.readValue(json, bodyType);
            Object[] args = m.getParameterCount() == 1 ? new Object[]{ bound } : new Object[]{ 1L, bound };
            ResponseEntity<?> res = (ResponseEntity<?>) m.invoke(controller, args);
            return res.getStatusCode().value() + (res.getStatusCode().value() == 400
                ? " " + PLAIN.writeValueAsString(res.getBody()) : "");
        }
        throw new AssertionError("no handler " + handler);
    }

    /** The same request through a failing and a tolerant mapper: one answer. */
    private String same(Built b, String simple, Class<?> repoType, String handler, String json) throws Exception {
        String strict = answer(b.controller(simple, repoType, mapper(true)), mapper(true), handler, json);
        String lax = answer(b.controller(simple, repoType, mapper(false)), mapper(false), handler, json);
        assertEquals(handler + " " + json + ": the host mapper must not change the answer", strict, lax);
        return strict;
    }

    @Test
    public void rejectAnswersUnknownFieldsTheSameUnderEveryMapper() throws Exception {
        Built b = new Built(ApiSettings.DEFAULT, "reject");
        String refusal = "400 {\"error\":\"unknown_fields\",\"fields\":[\"isAdmin\",\"zebra\"]}";

        // create, PUT and PATCH: every undeclared key listed, in code-point order, nothing written
        assertEquals(refusal, same(b, "ThingController", b.thingRepo, "create", "{\"title\":\"t\",\"zebra\":1,\"isAdmin\":true}"));
        assertEquals(refusal, same(b, "ThingController", b.thingRepo, "update", "{\"title\":\"t\",\"zebra\":1,\"isAdmin\":true}"));
        assertEquals(refusal, same(b, "AuthController", b.authRepo, "createBridge", "{\"quantity\":1,\"zebra\":1,\"isAdmin\":true}"));
        assertEquals(refusal, same(b, "AuthController", b.authRepo, "updateBridge", "{\"quantity\":1,\"zebra\":1,\"isAdmin\":true}"));
        assertTrue("a refused body writes nothing: " + b.writes, b.writes.isEmpty());

        // declared keys the client may not set stay known (dropped, not refused): the generated key,
        // readOnly, @autoSet; and a sibling subtype's column on a TPH route
        assertEquals("201", same(b, "ThingController", b.thingRepo, "create",
            "{\"id\":9,\"title\":\"t\",\"role\":\"admin\",\"stamped\":null}"));
        assertEquals("404", same(b, "ThingController", b.thingRepo, "update", "{\"id\":9,\"title\":\"t\",\"role\":\"admin\"}"));
        assertEquals("201", same(b, "AuthController", b.authRepo, "createBridge", "{\"type\":\"Copay\",\"quantity\":1,\"approver\":\"x\"}"));
        assertEquals("404", same(b, "AuthController", b.authRepo, "updateBridge", "{\"quantity\":1,\"approver\":\"x\"}"));
        assertTrue("accepted bodies reach the repository: " + b.writes, b.writes.size() >= 4);
    }

    @Test
    public void dropIgnoresUnknownFieldsTheSameUnderEveryMapper() throws Exception {
        Built b = new Built(new ApiSettings(null, ApiSettings.UnknownFields.DROP), "drop");
        assertEquals("201", same(b, "ThingController", b.thingRepo, "create", "{\"title\":\"t\",\"zebra\":1,\"isAdmin\":true}"));
        assertEquals("404", same(b, "ThingController", b.thingRepo, "update", "{\"title\":\"t\",\"zebra\":1}"));
        assertEquals("201", same(b, "AuthController", b.authRepo, "createBridge", "{\"quantity\":1,\"zebra\":1}"));
        assertEquals("404", same(b, "AuthController", b.authRepo, "updateBridge", "{\"quantity\":1,\"zebra\":1}"));
    }

    @Test
    public void aBodyThatIsNotAnObjectIsLeftToTheExistingHandling() throws Exception {
        Built b = new Built(ApiSettings.DEFAULT, "nonobject");
        String answer = same(b, "ThingController", b.thingRepo, "create", "[1, 2]");
        assertTrue(answer, answer.startsWith("400 ") && !answer.contains("unknown_fields"));
    }

    @Test
    public void codePointOrderNotUtf16Order() {
        // U+FF5E (BMP) sorts before U+1F600 (a surrogate pair) by code point, after it by UTF-16 unit
        List<String> keys = new ArrayList<>(List.of("😀", "～"));
        var node = PLAIN.createObjectNode();
        for (String k : keys) node.put(k, 1);
        Map<String, Object> body = com.metaobjects.generator.spring.runtime.UnknownBodyKeys.refusal(node, java.util.Set.of());
        assertEquals(List.of("～", "😀"), body.get("fields"));
    }
}
