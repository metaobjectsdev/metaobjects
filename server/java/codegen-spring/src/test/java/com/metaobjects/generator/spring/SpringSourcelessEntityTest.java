package com.metaobjects.generator.spring;

import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * A SOURCELESS entity — {@code object.entity} with an {@code identity.primary} and no
 * {@code source.*} — is a record in a store MetaObjects does not manage (a MongoDB collection,
 * a Cassandra table, a Neo4j node, a remote API). It gets no controller and no repository
 * (#248); the adopter owns the data access. It keeps its wire contract: the DTO, a
 * presence-tracked {@code <E>Patch}, and the filter allowlist for the list endpoint the adopter
 * writes. Value objects are unchanged: ADR-0028 forbids them an identity.
 *
 * <p>Mirror of the TypeScript {@code sourceless-entity-surface.test.ts} and the Python
 * {@code test_sourceless_entity_surface.py}.</p>
 */
public class SpringSourcelessEntityTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.value": { "name": "LineItem", "children": [
                { "field.string": { "name": "sku", "@required": true } }
            ] } },
            { "object.entity": { "name": "Order", "children": [
                { "field.string": { "name": "id" } },
                { "field.string": { "name": "customerEmail", "@required": true, "@filterable": true } },
                { "field.enum":   { "name": "status", "@values": ["NEW", "SHIPPED"], "@filterable": true } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } },
            { "object.entity": { "name": "Note", "children": [
                { "field.string": { "name": "text" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void sourcelessEntityGetsDtoPatchAndAllowlistButNoRestSurface() throws Exception {
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "sourceless", FIXTURE);

        MetaObject order = loader.getMetaObjectByName("acme::shop::Order");
        MetaObject item = loader.getMetaObjectByName("acme::shop::LineItem");
        MetaObject note = loader.getMetaObjectByName("acme::shop::Note");
        assertNotNull(order);

        assertTrue(RestSurfaceGate.isSourcelessEntity(order));
        assertFalse("a value object has no identity (ADR-0028)", RestSurfaceGate.isSourcelessEntity(item));
        assertFalse("no identity: nothing to address", RestSurfaceGate.isSourcelessEntity(note));

        assertFalse("no store MetaObjects manages: no controller", SpringControllerGenerator.appliesTo(order));
        assertFalse("no store MetaObjects manages: no repository", SpringRepositoryGenerator.appliesTo(order));
        assertTrue("the adopter's list endpoint needs the allowlist", SpringFilterAllowlistGenerator.appliesTo(order));
        assertFalse(SpringFilterAllowlistGenerator.appliesTo(item));

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        SpringDtoGenerator dtoGen = new SpringDtoGenerator();
        dtoGen.setArgs(args);
        dtoGen.execute(loader);
        SpringFilterAllowlistGenerator allowGen = new SpringFilterAllowlistGenerator();
        allowGen.setArgs(args);
        allowGen.execute(loader);

        assertTrue(Files.exists(gen.resolve("acme/shop/OrderDto.java")));
        assertTrue("sourceless entity gets a PATCH shape", Files.exists(gen.resolve("acme/shop/OrderPatch.java")));
        assertTrue(Files.exists(gen.resolve("acme/shop/OrderFilterAllowlist.java")));
        assertFalse("an unidentified entity gets no PATCH shape", Files.exists(gen.resolve("acme/shop/NotePatch.java")));

        compile(gen);
    }

    private void compile(Path gen) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required", javac);
        Path classes = tmp.newFolder("classes").toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", System.getProperty("java.class.path"), "-d", classes.toString());
        if (!javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call()) {
            StringBuilder sb = new StringBuilder("generated sourceless-entity code failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            fail(sb.toString());
        }
    }
}
