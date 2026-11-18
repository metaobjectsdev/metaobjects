package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

/**
 * A generated class DROPS an undeclared JSON key only where it is a create or update request body:
 * an entity with a generated write route, and a value object nested in one. A response parser's
 * decode target, a prompt payload and a read-only projection are not request bodies, so they keep
 * the host mapper's strictness: a model reply carrying an extra key is still refused.
 *
 * <p>Compiles the generated sources and binds JSON through a Jackson mapper with
 * {@code FAIL_ON_UNKNOWN_PROPERTIES} on, the setting a plain {@code ObjectMapper} ships with.
 * Oracle: the rule above and Jackson's documented {@code @JsonIgnoreProperties} semantics. The
 * wrong behavior rejected is a blanket annotation, which would let {@code Reply} bind a stray key.</p>
 */
public class SpringRequestBodyUnknownKeysCompileRunTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private static final String META = """
        { "metadata.root": { "package": "acme::body", "children": [
          { "object.value": { "name": "Stamp", "children": [
            { "field.string": { "name": "by", "@maxLength": 20 } },
            { "field.object": { "name": "where", "@objectRef": "Place" } }
          ] } },
          { "object.value": { "name": "Place", "children": [
            { "field.string": { "name": "city", "@maxLength": 20 } }
          ] } },
          { "object.value": { "name": "Reply", "children": [
            { "field.string": { "name": "text", "@maxLength": 100 } }
          ] } },
          { "object.entity": { "name": "Doc", "children": [
            { "source.rdb": { "@table": "docs" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title", "@maxLength": 100 } },
            { "field.object": { "name": "stamp", "@objectRef": "Stamp", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    @Test
    public void onlyAWriteRoutesEntityAndTheValueObjectsNestedInItDropAnUndeclaredKey() throws Exception {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("ws").toPath(), "request-bodies", META);
        Path gen = tmp.newFolder("gen").toPath();
        for (var g : List.of(new SpringDtoGenerator(), new SpringValueObjectGenerator())) {
            g.setArgs(Map.of("outputDir", gen.toString()));
            g.execute(loader);
        }
        Path classes = tmp.newFolder("classes").toPath();
        SpringTestFixtures.compileGenerated(gen, classes);
        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {
            ObjectMapper strict = new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);

            // The entity DTO and the value objects nested in it, one and two levels down: stray key dropped.
            assertNotNull(strict.readValue(
                "{\"title\":\"t\",\"isAdmin\":true,\"stamp\":{\"by\":\"b\",\"zebra\":1,\"where\":{\"city\":\"c\",\"zebra\":2}}}",
                cl.loadClass("acme.body.DocDto")));

            // A value object nothing writable nests is not a request body: the strict mapper refuses it.
            assertThrows(UnrecognizedPropertyException.class, () -> strict.readValue(
                "{\"text\":\"hi\",\"zebra\":1}", cl.loadClass("acme.body.Reply")));
        }
    }
}
