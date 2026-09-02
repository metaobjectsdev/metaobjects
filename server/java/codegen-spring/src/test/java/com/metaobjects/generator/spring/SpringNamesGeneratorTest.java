package com.metaobjects.generator.spring;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for {@link SpringNamesGenerator} (spec A1/A2/A3/A6, program-A task 7). Mirrors
 * the shipped Kotlin {@code KotlinNamesGeneratorTest} and C# {@code NamesGeneratorTests}:
 *
 * <ul>
 *   <li>{@code public static final} members for KIND/NAME/READ_ONLY + per-field
 *       {@code _FIELD}/{@code _COLUMN} pairs, always both, so a field/column collision
 *       can never collapse to one constant.</li>
 *   <li>An explicit {@code @column} always wins over the naming strategy — never a
 *       hand-rolled re-derivation.</li>
 *   <li>{@code SCHEMA} omitted (never emitted as a null/literal placeholder) when
 *       undeclared, present when declared.</li>
 *   <li>#248: an object with no primary source emits nothing — participation is never
 *       gated on the object subtype.</li>
 *   <li>Two fields colliding on their SCREAMING_SNAKE member name is refused, naming
 *       the model.</li>
 *   <li>{@code codegen-spring} has no per-package namespace-override mechanism — a
 *       per-package layout puts {@code <Entity>Names} beside the entity it describes.</li>
 *   <li>Java's generated code carries no physical name anywhere else (unlike the other
 *       four ports), so nothing downstream would catch a wrong constant here for free —
 *       {@code everyEmittedColumnConstantExistsInTheCanonicalSchema} buys that coverage
 *       by checking against the schema the TypeScript migration toolchain actually
 *       produces (ADR-0015).</li>
 * </ul>
 *
 * <p>There are no golden/snapshot files in {@code codegen-spring}; every assertion here
 * is a substring check on the emitted source, matching
 * {@code SpringFilterAllowlistGeneratorTest}'s idiom.</p>
 */
public class SpringNamesGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    // Author carries the two distinguishing fields (mirrors the shipped Kotlin/C#
    // fixtures):
    //  - createdAt: no @column -- the DEFAULT (literal) strategy alone produces
    //    "createdAt", proving the FIELD/COLUMN pair is emitted even when nothing is
    //    declared explicitly.
    //  - callPurpose: an EXPLICIT @column "purpose_code" that NEITHER strategy would
    //    have produced on its own (literal -> "callPurpose", snake_case ->
    //    "call_purpose") -- the discriminator between "reads @column" and
    //    "re-derives from the field name".
    // The source.rdb declares NO @table at all -- proving getPhysicalName() (Step 4:
    // pluralize+snake_case of the OWNING ENTITY) is used, never getTableName() (which
    // is null here and would have emitted the literal string "null").
    private static final String AUTHOR_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "source.rdb": {} },
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "createdAt" } },
                { "field.string":    { "name": "callPurpose", "@maxLength": 40, "@column": "purpose_code" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private String emit(String fixtureJson, String relativeFilePath, Map<String, String> extraArgs) throws IOException {
        Path outDir = tempFolder.newFolder().toPath();
        Path workspace = tempFolder.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "names-fixture", fixtureJson);

        SpringNamesGenerator gen = new SpringNamesGenerator();
        Map<String, String> args = new HashMap<>(extraArgs);
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path file = outDir.resolve(relativeFilePath);
        assertTrue("expected " + file + " to exist", Files.exists(file));
        return Files.readString(file);
    }

    private String emitFor(String entityShortName) throws IOException {
        return emit(AUTHOR_FIXTURE, "acme/blog/" + entityShortName + "Names.java", Map.of());
    }

    private String emitFor(String entityShortName, Map<String, String> args) throws IOException {
        return emit(AUTHOR_FIXTURE, "acme/blog/" + entityShortName + "Names.java", args);
    }

    // -------------------------------------------------------------------------
    // Step 1 tests (task-7-brief), plus the corrections/extensions its own text calls for
    // -------------------------------------------------------------------------

    @Test
    public void emitsStaticFinalConstantsForTableAndColumns() throws IOException {
        String src = emitFor("Author");
        assertTrue(src, src.contains("public final class AuthorNames {"));
        assertTrue(src, src.contains("public static final String KIND = \"table\";"));
        assertTrue(src, src.contains("public static final String NAME = \"authors\";"));
        assertTrue(src, src.contains("public static final boolean READ_ONLY = false;"));
        assertTrue(src, src.contains("public static final String CREATED_AT_FIELD = \"createdAt\";"));
        // Java's default strategy is `literal`, matching ObjectManagerDB -- NOT snake_case.
        assertTrue(src, src.contains("public static final String CREATED_AT_COLUMN = \"createdAt\";"));
        assertTrue(src, src.contains("private AuthorNames() {}"));
    }

    @Test
    public void anImplicitlyNamedSourceStillResolvesItsPhysicalName() throws IOException {
        // The regression that matters: getTableName() returns null when @table is
        // unset (as it is here), and the design spec's Java citation told us to call
        // it. getPhysicalName() derives pluralize(snake_case) of the owning entity
        // instead. A null here would have emitted NAME = "null".
        assertTrue(emitFor("Author").contains("public static final String NAME = \"authors\";"));
    }

    @Test
    public void theColumnNamingArgIsHonoured() throws IOException {
        assertTrue(emitFor("Author", Map.of("columnNaming", "snake_case"))
            .contains("public static final String CREATED_AT_COLUMN = \"created_at\";"));
    }

    @Test
    public void anExplicitColumnBeatsTheStrategyUnderBothArms() throws IOException {
        // Neither strategy would independently produce "purpose_code"
        // (literal -> "callPurpose", snake_case -> "call_purpose") -- the explicit
        // @column must win under BOTH.
        String literal = emitFor("Author");
        assertTrue(literal, literal.contains("public static final String CALL_PURPOSE_COLUMN = \"purpose_code\";"));
        assertFalse(literal, literal.contains("\"call_purpose\""));

        String snake = emitFor("Author", Map.of("columnNaming", "snake_case"));
        assertTrue(snake, snake.contains("public static final String CALL_PURPOSE_COLUMN = \"purpose_code\";"));
        assertFalse(snake, snake.contains("\"call_purpose\""));
    }

    @Test
    public void columnsByFieldReferencesConstantsNotRepeatedLiterals() throws IOException {
        String src = emitFor("Author");
        assertTrue(src, src.contains("\"callPurpose\", CALL_PURPOSE_COLUMN"));
        assertTrue(src, src.contains("\"createdAt\", CREATED_AT_COLUMN"));
        assertTrue(src, src.contains("\"id\", ID_COLUMN"));
        // The map must not respell the physical column string a second time.
        assertFalse(src, src.contains("\"callPurpose\", \"purpose_code\""));
    }

    @Test
    public void anAbsentSchemaOmitsTheLineEntirely() throws IOException {
        // A `SCHEMA = null;` literal does not read as "undeclared" -- it must be
        // omitted from the file entirely, not emitted as a null/blank placeholder.
        assertFalse(emitFor("Author").contains("SCHEMA"));
    }

    @Test
    public void aDeclaredSchemaEmitsTheLine() throws IOException {
        String model = """
            {
              "metadata.root": { "package": "acme", "children": [
                { "object.entity": { "name": "Widget", "children": [
                    { "source.rdb": { "@table": "widgets", "@schema": "inventory" } },
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }
            """;
        String src = emit(model, "acme/WidgetNames.java", Map.of());
        assertTrue(src, src.contains("public static final String SCHEMA = \"inventory\";"));
    }

    @Test
    public void anInheritedFieldAndItsInheritedColumnBothResolve() throws IOException {
        // ADR-0039: getMetaFields() (defaults includeParentData=true) must see a field
        // AND @column declared on an abstract parent -- an own-only read would
        // silently drop it, so the constant would disagree with the column a
        // hand-written consumer actually binds to.
        String model = """
            {
              "metadata.root": { "package": "acme", "children": [
                { "object.entity": { "name": "BaseThing", "abstract": true, "children": [
                    { "field.string": { "name": "externalRef", "@column": "ext_ref" } }
                ] } },
                { "object.entity": { "name": "ConcreteThing", "extends": "BaseThing", "children": [
                    { "source.rdb": { "@table": "concrete_things" } },
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }
            """;
        String src = emit(model, "acme/ConcreteThingNames.java", Map.of());
        assertTrue(src, src.contains("public static final String EXTERNAL_REF_FIELD = \"externalRef\";"));
        assertTrue(src, src.contains("public static final String EXTERNAL_REF_COLUMN = \"ext_ref\";"));
    }

    @Test
    public void anObjectWithNoPrimarySourceEmitsNothing() throws IOException {
        // #248 -- participation derives from a declared/inherited primary source,
        // never from the object subtype. AddressValue (object.value) carries no
        // source at all (FR-024 value purity forbids one) and must not appear.
        String model = """
            {
              "metadata.root": { "package": "acme", "children": [
                { "object.value": { "name": "AddressValue", "children": [
                    { "field.string": { "name": "street" } }
                ] } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder().toPath();
        Path workspace = tempFolder.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "names-novalue", model);

        SpringNamesGenerator gen = new SpringNamesGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        assertFalse("expected no AddressValueNames.java to be emitted",
            Files.exists(outDir.resolve("acme/AddressValueNames.java")));
        try (var stream = Files.walk(outDir)) {
            assertEquals("expected NOTHING written under outDir", 0, stream.filter(Files::isRegularFile).count());
        }
    }

    @Test
    public void collidingScreamingSnakeMembersAreRefusedNamingTheModel() throws IOException {
        // userId and UserId both toSnakeCase()+uppercase() to USER_ID -- two duplicate
        // constant members. javac would refuse to compile the emitted .java, but the
        // error would name a generated file and read as a codegen bug. Fail here
        // instead, naming the entity and both offending field names.
        String model = """
            {
              "metadata.root": { "package": "acme", "children": [
                { "object.entity": { "name": "Weird", "children": [
                    { "source.rdb":   { "@table": "weirds" } },
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "userId" } },
                    { "field.string": { "name": "UserId" } },
                    { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }
            """;
        Path outDir = tempFolder.newFolder().toPath();
        Path workspace = tempFolder.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "names-collide", model);

        SpringNamesGenerator gen = new SpringNamesGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        try {
            gen.execute(loader);
            fail("expected GeneratorException");
        } catch (GeneratorException e) {
            String msg = e.getMessage();
            assertTrue(msg, msg.contains("Weird"));
            assertTrue(msg, msg.contains("userId"));
            assertTrue(msg, msg.contains("UserId"));
        }
    }

    @Test
    public void perPackageLayoutPutsTheArtifactBesideTheEntityItDescribes() throws IOException {
        // codegen-spring has NO per-package namespace-override arg -- every
        // per-entity generator in this package (including this one) derives its
        // output package mechanically from SpringNaming.splitFqn(entity.getName()).
        // Two packages, two entities both named "Thing": each ThingNames.java must
        // land in the SAME Java package as the entity it describes.
        String alphaModel = """
            {
              "metadata.root": { "package": "acme::alpha", "children": [
                { "object.entity": { "name": "Thing", "children": [
                    { "source.rdb": { "@table": "alpha_things" } },
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }
            """;
        String betaModel = """
            {
              "metadata.root": { "package": "acme::beta", "children": [
                { "object.entity": { "name": "Thing", "children": [
                    { "source.rdb": { "@table": "beta_things" } },
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
                ] } }
              ] }
            }
            """;

        Path outDir = tempFolder.newFolder().toPath();

        MetaDataLoader alphaLoader = SpringTestFixtures.loadFixture(tempFolder.newFolder().toPath(), "alpha", alphaModel);
        SpringNamesGenerator alphaGen = new SpringNamesGenerator();
        Map<String, String> alphaArgs = new HashMap<>();
        alphaArgs.put("outputDir", outDir.toString());
        alphaGen.setArgs(alphaArgs);
        alphaGen.execute(alphaLoader);

        MetaDataLoader betaLoader = SpringTestFixtures.loadFixture(tempFolder.newFolder().toPath(), "beta", betaModel);
        SpringNamesGenerator betaGen = new SpringNamesGenerator();
        Map<String, String> betaArgs = new HashMap<>();
        betaArgs.put("outputDir", outDir.toString());
        betaGen.setArgs(betaArgs);
        betaGen.execute(betaLoader);

        String alphaSrc = Files.readString(outDir.resolve("acme/alpha/ThingNames.java"));
        assertTrue(alphaSrc, alphaSrc.contains("package acme.alpha;"));
        assertTrue(alphaSrc, alphaSrc.contains("public static final String NAME = \"alpha_things\";"));

        String betaSrc = Files.readString(outDir.resolve("acme/beta/ThingNames.java"));
        assertTrue(betaSrc, betaSrc.contains("package acme.beta;"));
        assertTrue(betaSrc, betaSrc.contains("public static final String NAME = \"beta_things\";"));
    }

    // -------------------------------------------------------------------------
    // Step 6 -- the coverage the other ports get "for free" from a generated
    // consumer, which Java has none of. Compare the artifact against the schema the
    // TypeScript migration toolchain actually produces (ADR-0015: the DDL is the
    // authority) — the only thing that can catch a Java-side resolver drifting from
    // it, since codegen-spring emits no physical name into its own output anywhere.
    //
    // Correction to the brief: its Step 6 snippet names a table "authors", which does
    // not exist in fixtures/persistence-conformance/canonical/schema.postgres.sql.
    // "posts" does exist there (Post lives in fixtures/persistence-conformance's
    // meta.fitness.json; the Author fixture above is inline test-only metadata, never
    // part of that corpus).
    // -------------------------------------------------------------------------

    @Test
    public void everyEmittedColumnConstantExistsInTheCanonicalSchema() throws IOException {
        Path corpusRoot = findCorpusRoot();
        String canonicalMeta = Files.readString(
            corpusRoot.resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);
        String canonicalSchema = Files.readString(
            corpusRoot.resolve("canonical/schema.postgres.sql"), StandardCharsets.UTF_8);

        Path outDir = tempFolder.newFolder().toPath();
        Path workspace = tempFolder.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fitness", canonicalMeta);

        SpringNamesGenerator gen = new SpringNamesGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        // The canonical schema is pinned to the `literal` strategy -- see
        // server/typescript/packages/integration-tests/src/canonical-schema.ts's
        // CANONICAL_COLUMN_NAMING and fixtures/persistence-conformance/README.md's
        // "Result format" section, which both say so outright. That is ALSO Java's
        // own codegen default (see SpringNamesGenerator's javadoc), but it is passed
        // explicitly here rather than left implicit, so this test keeps pinning the
        // resolver against real DDL even if that default ever changes.
        args.put("columnNaming", "literal");
        gen.setArgs(args);
        gen.execute(loader);

        // Program, not Post: every one of Post's fields is single-word, so `literal`
        // and `snake_case` resolve every column identically and this assertion would
        // pass no matter which strategy the generator actually used -- proving
        // nothing. Program's `priceCents` field resolves to "priceCents" under
        // `literal` (matching the DDL below) and to "price_cents" under
        // `snake_case` (which the DDL does not have), so this fixture can actually
        // tell the two strategies apart.
        String src = Files.readString(outDir.resolve("fitness/ProgramNames.java"));
        Set<String> ddlColumns = parseColumns(canonicalSchema, "programs");

        Matcher colConst = Pattern.compile("_COLUMN = \"([^\"]+)\";").matcher(src);
        boolean any = false;
        while (colConst.find()) {
            any = true;
            String column = colConst.group(1);
            assertTrue("constant names a column the DDL does not create: " + column,
                ddlColumns.contains(column));
        }
        assertTrue("expected at least one _COLUMN constant in:\n" + src, any);
    }

    /** Extract the quoted column names of one {@code CREATE TABLE "<name>" (...)} block. */
    private static Set<String> parseColumns(String ddl, String tableName) {
        Matcher table = Pattern.compile(
            "CREATE TABLE \"" + Pattern.quote(tableName) + "\" \\(\n(.*?)\n\\);", Pattern.DOTALL)
            .matcher(ddl);
        if (!table.find()) {
            throw new IllegalStateException("table \"" + tableName + "\" not found in canonical schema");
        }
        Set<String> columns = new LinkedHashSet<>();
        Matcher col = Pattern.compile("(?m)^\\s*\"([A-Za-z0-9_]+)\"").matcher(table.group(1));
        while (col.find()) columns.add(col.group(1));
        return columns;
    }

    /** Walk up from cwd to find the persistence-conformance corpus, regardless of module cwd. */
    private static Path findCorpusRoot() {
        Path cur = Paths.get("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve("fixtures/persistence-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException(
            "Could not locate fixtures/persistence-conformance from " + Paths.get("").toAbsolutePath());
    }

    // -------------------------------------------------------------------------
    // Program-A task 7 -- java.util.Map.of(...) has overloads for 0-10 pairs only.
    // COLUMNS_BY_FIELD emitted one pair per field with NO ceiling, so an object with
    // 11+ fields emitted more than 10 pairs and javac refused the file outright.
    // Every other assertion in this class (and the sibling
    // everyEmittedColumnConstantExistsInTheCanonicalSchema test) reads emitted source
    // as TEXT and would pass on a file that cannot compile. This is the compile
    // assertion that closes that gap -- mirrors SpringProjectionDtoCompileRunTest's
    // in-process javac harness.
    // -------------------------------------------------------------------------

    @Test
    public void anObjectWithMoreThanTenFieldsCompiles() throws Exception {
        Path corpusRoot = findCorpusRoot();
        String canonicalMeta = Files.readString(
            corpusRoot.resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);

        Path outDir = tempFolder.newFolder().toPath();
        Path workspace = tempFolder.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fitness-compile", canonicalMeta);

        SpringNamesGenerator gen = new SpringNamesGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        args.put("columnNaming", "literal");
        gen.setArgs(args);
        gen.execute(loader);

        // AllTypes (fixtures/persistence-conformance's canonical corpus) is the one
        // object in this fixture carrying more than ten fields -- the natural
        // fixture named in the task brief, not a fixture invented for this test.
        Path allTypes = outDir.resolve("fitness/AllTypesNames.java");
        assertTrue("expected " + allTypes + " to exist", Files.exists(allTypes));
        String src = Files.readString(allTypes);

        int fieldConstants = 0;
        Matcher m = Pattern.compile("_FIELD = \"").matcher(src);
        while (m.find()) fieldConstants++;
        assertTrue("expected AllTypes to declare more than 10 fields (saw " + fieldConstants
                + ") -- otherwise this test exercises nothing", fieldConstants > 10);

        // The strongest available proof: compile EVERY emitted .java under outDir
        // (not just AllTypesNames.java) with the real system compiler.
        compileAll(outDir);
    }

    /**
     * Compile every generated {@code .java} under {@code root} with the in-process
     * JDK compiler. Fails with the diagnostics + source dump if compilation does
     * not succeed. Mirrors {@code SpringProjectionDtoCompileRunTest#compile}.
     */
    private void compileAll(Path root) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(root)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + root, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required -- getSystemJavaCompiler() returned null", javac);

        Path classes = tempFolder.newFolder("classes-" + root.getFileName()).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated names artifact(s) failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            fail(sb.toString());
        }
    }
}
