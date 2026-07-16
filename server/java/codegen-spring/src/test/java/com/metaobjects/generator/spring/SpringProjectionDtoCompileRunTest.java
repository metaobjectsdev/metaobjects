package com.metaobjects.generator.spring;

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
 * Projection / view-kind codegen guard for the Java port (Spring codegen).
 *
 * <p>Guards the bug class fixed in the TypeScript port (PR #80): a projection
 * generating non-compiling or inconsistent read/write artifacts. The C# port
 * pins this with {@code DbContextCompileTests} (compiles generated projection
 * code against real EF Core); the TS and Python ports gained equivalents. This
 * is the Java equivalent.</p>
 *
 * <p>The Java port models a projection as an {@code object.entity} whose primary
 * {@code source.rdb} carries {@code @kind="view"} (the {@code object.projection}
 * subtype is not yet live in Java). The contract under test:</p>
 * <ul>
 *   <li>{@link SpringDtoGenerator} DOES emit a read DTO for the view-kind entity
 *       (it applies to any concrete entity), and that DTO COMPILES with the
 *       in-process JDK compiler — proving the generated read artifact is
 *       well-formed Java.</li>
 *   <li>{@link SpringRepositoryGenerator}, {@link SpringControllerGenerator} and
 *       {@link SpringFilterAllowlistGenerator} all SKIP the view-kind entity (no
 *       write CRUD / no write-only types) — proving read/write consistency: the
 *       read DTO cannot reference an insert-record / repository / write surface
 *       that was never emitted.</li>
 * </ul>
 *
 * <p>The fixture deliberately mixes a REQUIRED {@code id} (the projection's
 * stable key) with a NON-required derived column ({@code weekCount}, an
 * aggregate-style read-only field) so the DTO has to surface both a key and a
 * nullable derived component — the exact shape the TS bug produced inconsistent
 * artifacts for.</p>
 *
 * <p><b>Why a real {@code javac} compile.</b> A structural string assertion can
 * pass on source that does not actually compile (a dangling reference to an
 * un-emitted write type, a malformed record header). Running the system Java
 * compiler over the generated DTO is the strongest available proof the read
 * artifact is consistent and self-contained — mirroring the C# port compiling
 * generated projection code against EF Core. The skip assertions then prove no
 * write surface was emitted for the read DTO to be inconsistent with.</p>
 */
public class SpringProjectionDtoCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /**
     * A view-kind (projection) entity {@code ProgramSummary} that extends a base
     * {@code Program} table entity. Its primary source is {@code source.rdb} with
     * {@code @kind="view"}, a REQUIRED {@code id} and a NON-required derived
     * {@code weekCount} column.
     */
    private static final String PROJECTION_FIXTURE = """
        {
          "metadata.root": { "package": "acme::commerce", "children": [
            { "object.entity": { "name": "Program", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "title", "@maxLength": 200, "@required": true } },
                { "source.rdb":   { "@table": "programs" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "ProgramSummary", "children": [
                { "field.long":   { "name": "id", "@required": true } },
                { "field.string": { "name": "title", "@maxLength": 200, "@required": true } },
                { "field.int":    { "name": "weekCount" } },
                { "source.rdb":   { "@table": "v_program_summary", "@kind": "view" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void projectionDtoCompilesAndNoWriteSurfaceIsEmitted() throws Exception {
        Path gen = tmp.newFolder("gen-projection").toPath();
        Path ws  = tmp.newFolder("ws-projection").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "projection", PROJECTION_FIXTURE);

        MetaObject summary = loader.getMetaObjectByName("acme::commerce::ProgramSummary");
        assertNotNull("view-kind projection entity must load", summary);

        // --- consistency: the read DTO applies; every write surface SKIPS the view ---
        assertTrue("a concrete entity (even view-kind) gets a read DTO",
                SpringDtoGenerator.appliesTo(summary));
        assertFalse("view-kind entity has no writable repository",
                SpringRepositoryGenerator.appliesTo(summary));
        assertFalse("view-kind entity has no write controller",
                SpringControllerGenerator.appliesTo(summary));
        assertFalse("view-kind entity has no filter allowlist (no query/write surface)",
                SpringFilterAllowlistGenerator.appliesTo(summary));

        // --- generate the read DTO (only the generator that applies to a projection) ---
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        SpringDtoGenerator dtoGen = new SpringDtoGenerator();
        dtoGen.setArgs(args);
        dtoGen.execute(loader);

        Path dto = gen.resolve("acme/commerce/ProgramSummaryDto.java");
        assertTrue("expected ProgramSummaryDto.java at " + dto, Files.exists(dto));
        String src = Files.readString(dto);

        // The read DTO surfaces the required key AND the non-required derived column.
        assertTrue("read DTO must carry the projection key `Long id`; saw:\n" + src,
                src.contains("Long id"));
        assertTrue("read DTO must carry the derived `Integer weekCount`; saw:\n" + src,
                src.contains("Integer weekCount"));

        // The read DTO must NOT reference an insert/write-only analog that was never
        // emitted (the TS bug-class: a read artifact pointing at a non-existent write
        // type). No InsertSchema / *InsertDto / *CreateDto / Repository reference.
        assertFalse("read DTO must not reference an InsertSchema analog; saw:\n" + src,
                src.contains("InsertSchema"));
        assertFalse("read DTO must not reference an Insert/Create write record; saw:\n" + src,
                src.contains("InsertDto") || src.contains("CreateDto"));
        assertFalse("read DTO must not reference a Repository write surface; saw:\n" + src,
                src.contains("Repository"));

        // No write surface files were emitted alongside the read DTO.
        assertFalse("no repository should be emitted for a view-kind entity",
                Files.exists(gen.resolve("acme/commerce/ProgramSummaryRepository.java")));
        assertFalse("no controller should be emitted for a view-kind entity",
                Files.exists(gen.resolve("acme/commerce/ProgramSummaryController.java")));

        // --- strongest proof: the generated read DTO actually COMPILES ---
        compile(gen);
    }

    /**
     * #195 native typing — a projection field derived by {@code origin.aggregate}
     * {@code @agg:any|all|collect} is COALESCE-guaranteed non-null on read, so its DTO
     * component is {@code @NotNull}; an {@code origin.first} (empty set &rarr; null) and
     * an {@code origin.computed} (expression-dependent nullability) component stay nullable
     * (no {@code @NotNull}). Mirrors the TS {@code originGuaranteedNonNull} change.
     */
    private static final String NULLABILITY_FIXTURE = """
        {
          "metadata.root": { "package": "acme::sessions", "children": [
            { "object.entity": { "name": "Session", "children": [
                { "source.rdb": { "@table": "sessions" } },
                { "field.long": { "name": "id" } },
                { "relationship.association": { "name": "turns", "@objectRef": "Turn", "@cardinality": "many" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Turn", "children": [
                { "source.rdb": { "@table": "turns" } },
                { "field.long": { "name": "id" } },
                { "field.boolean": { "name": "success" } },
                { "field.string": { "name": "label" } },
                { "field.timestamp": { "name": "createdAt" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "SessionSummary", "children": [
                { "source.rdb": { "@table": "v_session", "@kind": "view" } },
                { "field.long": { "name": "id", "extends": "Session.id" } },
                { "field.string": { "name": "labelsCollect", "isArray": true, "children": [
                    { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns" } } ] } },
                { "field.boolean": { "name": "anyError", "children": [
                    { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } } ] } },
                { "field.string": { "name": "latestLabel", "children": [
                    { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } } ] } },
                { "field.boolean": { "name": "computedFlag", "children": [
                    { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "id" } } } } ] } },
                { "identity.primary": { "name": "pk", "extends": "Session.pk" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void originAnyAllCollectFieldsAreNotNull_firstAndComputedStayNullable() throws Exception {
        Path gen = tmp.newFolder("gen-nullability").toPath();
        Path ws  = tmp.newFolder("ws-nullability").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "nullability", NULLABILITY_FIXTURE);

        MetaObject summary = loader.getMetaObjectByName("acme::sessions::SessionSummary");
        assertNotNull("projection must load", summary);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        SpringDtoGenerator dtoGen = new SpringDtoGenerator();
        dtoGen.setArgs(args);
        dtoGen.execute(loader);

        Path dto = gen.resolve("acme/sessions/SessionSummaryDto.java");
        assertTrue("expected SessionSummaryDto.java at " + dto, Files.exists(dto));
        String src = Files.readString(dto);

        // collect + any → COALESCE-guaranteed non-null → @NotNull on the component.
        assertTrue("collect field must be @NotNull; saw:\n" + src, componentIsNotNull(src, "labelsCollect"));
        assertTrue("any-predicate field must be @NotNull; saw:\n" + src, componentIsNotNull(src, "anyError"));
        // first (empty set → null) + computed (expression-dependent) → stay nullable.
        assertFalse("first field must stay nullable (no @NotNull); saw:\n" + src, componentIsNotNull(src, "latestLabel"));
        assertFalse("computed field must stay nullable (no @NotNull); saw:\n" + src, componentIsNotNull(src, "computedFlag"));

        compile(gen);
    }

    /** True iff the DTO record component for {@code fieldName} (one line ending in the
     *  name, optionally comma-terminated) carries {@code @NotNull}. */
    private static boolean componentIsNotNull(String src, String fieldName) {
        for (String line : src.split("\n")) {
            String t = line.trim();
            if (t.equals(fieldName) || t.equals(fieldName + ",")
                    || t.endsWith(" " + fieldName) || t.endsWith(" " + fieldName + ",")) {
                return t.contains("@NotNull");
            }
        }
        throw new AssertionError("no DTO component line found for field '" + fieldName + "' in:\n" + src);
    }

    /**
     * Compile every generated {@code .java} under {@code gen} with the in-process
     * JDK compiler ({@code render}/{@code om} are on the test classpath). Fails
     * with the diagnostics + source dump if compilation does not succeed.
     */
    private void compile(Path gen) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + gen.getFileName()).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated projection DTO failed to compile:\n");
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
