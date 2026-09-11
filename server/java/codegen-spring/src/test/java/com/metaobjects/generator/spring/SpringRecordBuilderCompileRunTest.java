package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The Java builder on generated records (#365, the Java-record half).
 *
 * <p>A record's only constructor takes every component in order, so a caller setting 2 of 5
 * passed 5 arguments and broke whenever a component was added. Every other test here reads the
 * generated SOURCE, where that cost is invisible; this one compiles a real Java caller against
 * the generated records and runs it, so it fails exactly the way an adopter's call site would.</p>
 *
 * <p>Covers the three record emitters — an entity's wire DTO, an {@code object.value} (emitted
 * because the entity's jsonb {@code address} column reaches it), and a
 * {@code template.prompt} payload — and the one deliberate exclusion: a projection's read DTO,
 * which arrives from a query and which nothing should construct.</p>
 */
public class SpringRecordBuilderCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Customer", "children": [
                { "source.rdb": { "@table": "customers" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "email", "@required": true } },
                { "field.string": { "name": "name" } },
                { "field.enum":   { "name": "status", "@values": ["ACTIVE", "CLOSED"] } },
                { "field.object": { "name": "address", "@objectRef": "Address", "@storage": "jsonb" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "CustomerSummary", "children": [
                { "source.rdb": { "@table": "v_customer_summary", "@kind": "view" } },
                { "field.long":   { "name": "id", "@required": true } },
                { "field.string": { "name": "email" } }
            ] } },
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } },
                { "field.string": { "name": "city" } },
                { "field.int":    { "name": "zip" } }
            ] } },
            { "object.value": { "name": "GreetArgs", "children": [
                { "field.string": { "name": "name" } },
                { "field.string": { "name": "tone" } }
            ] } },
            { "template.prompt": {
                "name": "greetCustomer",
                "@payloadRef": "GreetArgs",
                "@textRef": "shop/greet",
                "@format": "xml"
            } }
          ] }
        }
        """;

    /** Sets 2 components through each builder and reports what came back. */
    private static final String CALLER = """
        package acme.shop;

        import acme.shop.prompts.GreetCustomerPayload;

        public final class Caller {
            public static String run() {
                CustomerDto c = CustomerDto.builder().email("ada@example.com").name("Ada").build();
                Address a = Address.builder().street("1 Main St").zip(12345).build();
                GreetCustomerPayload p = GreetCustomerPayload.builder().name("Ada").build();
                return c.email() + "|" + c.name() + "|" + c.id() + "|" + c.status()
                    + "|" + a.street() + "|" + a.zip() + "|" + a.city()
                    + "|" + p.name() + "|" + p.tone();
            }
        }
        """;

    @Test
    public void aJavaCallerSetsASubsetOfComponentsThroughEachBuilder() throws Exception {
        Path gen = tmp.newFolder("gen").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("ws").toPath(), "shop", FIXTURE);
        for (MultiFileDirectGeneratorBase<?> g : List.<MultiFileDirectGeneratorBase<?>>of(
                new SpringDtoGenerator(), new SpringValueObjectGenerator(), new SpringPayloadGenerator())) {
            Map<String, String> args = new HashMap<>();
            args.put("outputDir", gen.toString());
            g.setArgs(args);
            g.execute(loader);
        }

        // A projection's read DTO is derived, so it must not advertise construction.
        String summary = Files.readString(gen.resolve("acme/shop/CustomerSummaryDto.java"));
        assertFalse("a projection DTO must carry no builder; saw:\n" + summary, summary.contains("Builder"));

        Path caller = tmp.newFolder("caller").toPath().resolve("acme/shop/Caller.java");
        Files.createDirectories(caller.getParent());
        Files.writeString(caller, CALLER);
        Path classes = compile(gen, caller);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[] { classes.toUri().toURL() }, getClass().getClassLoader())) {
            Object out = cl.loadClass("acme.shop.Caller").getMethod("run").invoke(null);
            assertEquals("ada@example.com|Ada|null|null|1 Main St|12345|null|Ada|null", out);
        }
    }

    @Test
    public void aComponentNamedBuilderSuppressesTheBuilderRatherThanCollideWithIt() {
        // Its accessor `builder()` and the static factory `builder()` would share a signature.
        assertEquals("", SpringRecordBuilder.members("Widget",
            List.of(new String[] { "String", "name" }, new String[] { "String", "builder" })));
        assertTrue(SpringRecordBuilder.members("Widget", List.<String[]>of(new String[] { "String", "name" }))
            .contains("public static Builder builder()"));
        assertEquals("a record with no components has nothing to build",
            "", SpringRecordBuilder.members("Empty", List.of()));
        // A nested class may not share its enclosing class's name, and it would shadow a
        // component type named Builder inside the builder.
        assertEquals("", SpringRecordBuilder.members("Builder", List.<String[]>of(new String[] { "String", "name" })));
        assertEquals("", SpringRecordBuilder.members("Widget", List.<String[]>of(new String[] { "acme.Builder", "b" })));
        assertEquals("", SpringRecordBuilder.members("Widget",
            List.<String[]>of(new String[] { "java.util.List<Builder>", "bs" })));
        assertTrue("a type merely CONTAINING the word is not a collision",
            SpringRecordBuilder.members("Widget", List.<String[]>of(new String[] { "StringBuilder", "sb" }))
                .contains("public static Builder builder()"));
    }

    private Path compile(Path gen, Path extra) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        sources.add(extra.toFile());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);
        Path classes = tmp.newFolder("classes").toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", System.getProperty("java.class.path"), "-d", classes.toString());
        if (!javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call()) {
            StringBuilder sb = new StringBuilder("generated records + caller failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null));
                if (d.getSource() != null) sb.append(" at ").append(d.getSource().getName()).append(':').append(d.getLineNumber());
                sb.append('\n');
            }
            fail(sb.toString());
        }
        return classes;
    }
}
