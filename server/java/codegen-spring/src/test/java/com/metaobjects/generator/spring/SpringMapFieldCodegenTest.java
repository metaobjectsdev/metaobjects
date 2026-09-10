package com.metaobjects.generator.spring;

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
 * {@code field.map} — an open-keyed map ({@code Map<String, V>}) stored in a single
 * jsonb column (the map analog of {@code field.object}). The value type is a scalar
 * ({@code @valueType}) or a value object ({@code @objectRef}).
 *
 * <p>Cross-port parity: the C# {@code MapFieldCodegenTests}, the Kotlin
 * {@code KotlinTypeMapperTest} map arms, the TS {@code field-map.test.ts} and the
 * Python entity-model map branch. Before this suite the Spring port had NO
 * {@code MapField} arm at all, so any entity carrying a mapped field failed codegen
 * outright at {@code SpringTypeMapper}'s unsupported-type throw.</p>
 */
public class SpringMapFieldCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String MAP_FIXTURE = """
        {
          "metadata.root": { "package": "acme::crm", "children": [
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
                { "field.string": { "name": "city", "@maxLength": 80 } }
            ] } },
            { "object.entity": { "name": "Customer", "children": [
                { "source.rdb":   { "@table": "customers" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "field.map":    { "name": "labels", "@valueType": "string" } },
                { "field.map":    { "name": "scores", "@valueType": "int" } },
                { "field.map":    { "name": "addresses", "@objectRef": "Address" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    /** Run {@link SpringDtoGenerator} + {@link SpringValueObjectGenerator} over the fixture. */
    private Path generate(String label) throws Exception {
        Path gen = tmp.newFolder("gen-" + label).toPath();
        Path ws = tmp.newFolder("ws-" + label).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "map-" + label, MAP_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringDtoGenerator dtoGen = new SpringDtoGenerator();
        dtoGen.setArgs(args);
        dtoGen.execute(loader);

        SpringValueObjectGenerator voGen = new SpringValueObjectGenerator();
        voGen.setArgs(args);
        voGen.execute(loader);

        return gen;
    }

    /**
     * Run EVERY entity-facing Spring generator over the fixture. The unsupported-type throw
     * lived in the shared type mapper, so a map could break ANY generator that types a field
     * -- fixing the DTO path alone would leave the repository / controller / allowlist /
     * names surfaces failing on the same model. This drives all of them.
     */
    private Path generateAll(String label) throws Exception {
        Path gen = tmp.newFolder("all-" + label).toPath();
        Path ws = tmp.newFolder("allws-" + label).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "mapall-" + label, MAP_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : List.of(
                new SpringDtoGenerator(),
                new SpringValueObjectGenerator(),
                new SpringNamesGenerator(),
                new SpringRepositoryGenerator(),
                new SpringControllerGenerator(),
                new SpringFilterAllowlistGenerator())) {
            g.setArgs(args);
            g.execute(loader);
        }
        return gen;
    }

    @Test
    public void everyEntityFacingGeneratorHandlesAMapCarryingEntity() throws Exception {
        // Regression gate for the SHAPE of the original defect: the throw was in the shared
        // SpringTypeMapper, so every generator that types a field inherited it. If any of
        // these still refuses a field.map this call raises IllegalArgumentException.
        Path gen = generateAll("smoke");

        assertTrue("expected the DTO", Files.exists(gen.resolve("acme/crm/CustomerDto.java")));
        assertTrue("expected the repository", Files.exists(gen.resolve("acme/crm/CustomerRepository.java")));
        assertTrue("expected the controller", Files.exists(gen.resolve("acme/crm/CustomerController.java")));

        // The filter allowlist must not offer the map as a filterable column: no port can
        // lower a filter operator over an open-keyed jsonb map, so silently admitting one
        // would generate a query surface that fails at the engine.
        Path allowlist = gen.resolve("acme/crm/CustomerFilterAllowlist.java");
        // Asserted UNCONDITIONALLY: guarding this on Files.exists would let the whole check
        // evaporate the day the allowlist stops being emitted, gating nothing.
        assertTrue("expected the filter allowlist at " + allowlist, Files.exists(allowlist));
        String src = Files.readString(allowlist);
        assertFalse("a field.map must not be filterable; saw:\n" + src, src.contains("\"labels\""));
        assertFalse("a field.map must not be filterable; saw:\n" + src, src.contains("\"addresses\""));
    }

    @Test
    public void scalarValuedMapBecomesAMapRecordComponent() throws Exception {
        Path gen = generate("scalar");
        String dto = Files.readString(gen.resolve("acme/crm/CustomerDto.java"));

        // @valueType:string -> Map<String, String>; @valueType:int -> Map<String, Integer>
        // (the WRAPPED Integer — Map<String, int> is not expressible in Java, and the
        // wrapper is what the rest of the DTO surface uses for missing-field nullability).
        assertTrue("expected a Map<String, String> component for @valueType:string; saw:\n" + dto,
                dto.contains("java.util.Map<String, String> labels"));
        assertTrue("expected a Map<String, Integer> component for @valueType:int; saw:\n" + dto,
                dto.contains("java.util.Map<String, Integer> scores"));
    }

    @Test
    public void objectValuedMapBecomesAMapOfTheValueObjectRecord() throws Exception {
        Path gen = generate("objectref");
        String dto = Files.readString(gen.resolve("acme/crm/CustomerDto.java"));

        // @objectRef:Address -> Map<String, Address>, resolved exactly as the field.object
        // arm resolves its @objectRef (SpringNaming.splitFqn over the RESOLVED MetaObject).
        assertTrue("expected a Map<String, Address> component for @objectRef; saw:\n" + dto,
                dto.contains("java.util.Map<String, acme.crm.Address> addresses"));

        // The referenced value object must actually be EMITTED. The reachability walk used
        // to look only at field.object, so a map-only VO reference produced a DTO naming a
        // record that was never generated — a guaranteed compile failure downstream.
        Path vo = gen.resolve("acme/crm/Address.java");
        assertTrue("expected the map-referenced value object at " + vo, Files.exists(vo));
        assertTrue("expected an Address record declaration; saw:\n" + Files.readString(vo),
                Files.readString(vo).contains("record Address"));
    }

    @Test
    public void objectValuedMapComponentCascadesValidation() throws Exception {
        Path gen = generate("valid");
        String dto = Files.readString(gen.resolve("acme/crm/CustomerDto.java"));

        // Parity with the TS zod emit, which types an @objectRef map as
        // z.record(z.string(), <VO>InsertSchema) — i.e. the map VALUES are validated.
        // @Valid on a Map component cascades to its values under Bean Validation, so the
        // nested VO's own constraints (Address.street @NotNull/@Size) are enforced on POST.
        assertTrue("expected @Valid on the value-object map component; saw:\n" + dto,
                dto.contains("@Valid java.util.Map<String, acme.crm.Address> addresses"));
        // A SCALAR-valued map has no nested bean to cascade into — it must NOT get @Valid.
        assertFalse("a scalar-valued map must not be annotated @Valid; saw:\n" + dto,
                dto.contains("@Valid java.util.Map<String, String> labels"));
    }

    @Test
    public void generatedMapCarryingSourcesCompile() throws Exception {
        // The strongest proof: the emitted DTO + value-object records compile together.
        // This is what catches a Map<String, int> (illegal type argument) or a DTO naming
        // a value object the reachability walk never emitted.
        Path gen = generate("compile");

        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-map").toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of(
                "-classpath", System.getProperty("java.class.path"),
                "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated map-carrying sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            for (File f : sources) {
                sb.append("\n=== ").append(f.getName()).append(" ===\n");
                sb.append(Files.readString(f.toPath())).append('\n');
            }
            fail(sb.toString());
        }
    }
}
