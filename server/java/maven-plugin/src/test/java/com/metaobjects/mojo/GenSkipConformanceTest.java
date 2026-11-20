package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.project.MavenProject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Runs the shared table of ADR-0064 cases ({@code fixtures/codegen-skip-conformance/cases.json})
 * against the JVM project shape: a Maven module whose pom configures one generator (a stand-in
 * for any stock Java or Kotlin generator, which all run through this same goal and the same
 * {@code Generator} SPI), a template root, a declared extra input and an owned generator
 * directory. Each case runs {@code generate} once, applies the change, and asks both goals what
 * they would do. A case id this runner does not know fails the run.
 */
public class GenSkipConformanceTest {

    private static final Path CASES = Path.of("../../../fixtures/codegen-skip-conformance/cases.json");

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** Counts how many times a generator really ran, and carries the per-case switches. */
    public static class FixtureGenerator extends GeneratorBase {
        static int runs;
        static boolean cacheable = true;
        static boolean fail = false;
        static Path extra;

        @Override
        public boolean cacheable() {
            return cacheable;
        }

        @Override
        public List<String> extraInputs() {
            List<String> out = new ArrayList<>();
            out.add(getArg("templatesDir"));
            if (extra != null) out.add(extra.toString());
            return out;
        }

        @Override
        public void execute(MetaDataLoader loader) {
            runs++;
            if (fail) throw new IllegalStateException("simulated failure");
            try {
                GeneratedFileWriter.write(getOutputDir().toPath().resolve("Out.java"),
                        "/** GENERATED */\nclass Out { /* " + getArg("content", "x") + " */ }\n");
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private Path project;
    private Path engine;
    private String content;
    private boolean lax;
    private String ci;
    private boolean verifyFull;   // -Dmetaobjects.verify.full=true, the verify spelling of --force

    @Before
    public void setUp() throws IOException {
        project = tmp.getRoot().toPath();
        engine = tmp.newFolder("engine").toPath();
        FixtureGenerator.runs = 0;
        FixtureGenerator.cacheable = true;
        FixtureGenerator.fail = false;
        FixtureGenerator.extra = null;
        setUpFiles();
    }

    @After
    public void tearDown() {
        FixtureGenerator.cacheable = true;
        FixtureGenerator.fail = false;
        FixtureGenerator.extra = null;
    }

    private MavenProject mavenProject() {
        MavenProject p = Mockito.mock(MavenProject.class);
        Mockito.when(p.getBasedir()).thenReturn(project.toFile());
        return p;
    }

    private LoaderParam loader() {
        return LoaderParam.builder("skip-conformance")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.resolve("metaobjects").toString())
                .build();
    }

    private List<GeneratorParam> generators() {
        GeneratorParam g = new GeneratorParam();
        g.setClassname(FixtureGenerator.class.getName());
        g.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, "gen", "templatesDir", "tpl", "content", content));
        return List.of(g);
    }

    private void gen(boolean force) throws Exception {
        gen(force, null);
    }

    private void gen(boolean force, String entities) throws Exception {
        MetaDataGeneratorMojo m = new MetaDataGeneratorMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }
        };
        m.project = mavenProject();
        m.setLoader(loader());
        m.setGenerators(generators());
        m.setLax(lax);
        m.force = force;
        m.entities = entities;
        m.execute();
    }

    /** Runs verify and returns how many generator runs it spent. Drift is not what this asks. */
    private int verifyRenders() {
        MetaDataVerifyMojo m = new MetaDataVerifyMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }

            @Override
            String getEnv(String name) {
                return "CI".equals(name) ? ci : super.getEnv(name);
            }
        };
        m.project = mavenProject();
        m.setLoader(loader());
        m.setGenerators(generators());
        m.setLax(lax);
        m.setMode(MetaDataVerifyMojo.MODE_CODEGEN);
        m.setFull(verifyFull);
        int before = FixtureGenerator.runs;
        try {
            m.execute();
        } catch (Exception drift) {
            // a render that found drift still rendered
        }
        return FixtureGenerator.runs - before;
    }

    /**
     * A run naming entities forces exactly those: it never skips, never stores a key, and leaves
     * the stored full-run fingerprint alone, so the next full run still skips.
     */
    @Test
    public void narrowedRunNeverSkipsNorTouchesTheFullRunKey() throws Exception {
        gen(false);
        Path stateDir = project.resolve(".metaobjects/.gen-state");
        Path fp;
        try (var s = Files.list(stateDir)) {
            fp = s.filter(p -> p.getFileName().toString().startsWith(".fingerprint-java-")).findFirst().orElseThrow();
        }
        byte[] stored = Files.readAllBytes(fp);

        int before = FixtureGenerator.runs;
        gen(false, "Gizmo");
        assertEquals("a narrowed run executes over unchanged inputs", before + 1, FixtureGenerator.runs);
        assertTrue("the full-run fingerprint is still there", Files.isRegularFile(fp));
        assertTrue("the full-run fingerprint is byte-for-byte unchanged", java.util.Arrays.equals(stored, Files.readAllBytes(fp)));

        // A failed narrowed run leaves it alone too.
        FixtureGenerator.fail = true;
        try {
            gen(false, "Gizmo");
            fail("the failing run must fail");
        } catch (RuntimeException expected) {
            // simulated failure
        }
        FixtureGenerator.fail = false;
        assertTrue("a failed narrowed run keeps the fingerprint bytes",
                java.util.Arrays.equals(stored, Files.readAllBytes(fp)));

        before = FixtureGenerator.runs;
        gen(false);
        assertEquals("the next full run still skips", before, FixtureGenerator.runs);
    }

    /** Item 9: a rendering verify leaves no temp tree behind, with DEV_SCRATCH set or not, clean or drifted. */
    @Test
    public void verifyLeavesNoTempFiles() throws Exception {
        gen(false);
        Path scratch = tmp.newFolder("scratch").toPath();
        Path sysTmp = Path.of(System.getProperty("java.io.tmpdir"));
        long before = countVerifyTemps(sysTmp);
        ci = "true";                                   // CI always renders
        verifyWithScratch(null);
        verifyWithScratch(scratch.toString());
        Files.writeString(project.resolve("gen/Out.java"), "// drifted\n");
        verifyWithScratch(scratch.toString());          // the drift failure path
        ci = null;
        assertEquals("nothing left under DEV_SCRATCH", 0, countVerifyTemps(scratch));
        assertEquals("nothing left under the system temp dir", before, countVerifyTemps(sysTmp));
    }

    private static long countVerifyTemps(Path dir) throws IOException {
        try (var s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().startsWith("metaobjects-verify")).count();
        }
    }

    private void verifyWithScratch(String scratch) {
        MetaDataVerifyMojo m = new MetaDataVerifyMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }

            @Override
            String getEnv(String name) {
                if ("CI".equals(name)) return ci;
                if ("DEV_SCRATCH".equals(name)) return scratch;
                return super.getEnv(name);
            }
        };
        m.project = mavenProject();
        m.setLoader(loader());
        m.setGenerators(generators());
        m.setMode(MetaDataVerifyMojo.MODE_CODEGEN);
        try {
            m.execute();
        } catch (Exception drift) {
            // drift is allowed here; only the leftovers matter
        }
    }

    private void applyChange(String id) throws Exception {
        switch (id) {
            case "no-change", "fingerprint-missing-placeholder" -> { }
            case "metadata-touched" -> {
                Path f = project.resolve("metaobjects/meta.shop.json");
                Files.writeString(f, Files.readString(f));
            }
            case "unrelated-file-edited" -> Files.writeString(project.resolve("README.md"), "edited");
            case "metadata-reformatted" -> Files.writeString(project.resolve("metaobjects/meta.extra.json"), """
                    {
                      "metadata.root": {
                        "children": [ { "object.entity": { "children": [ { "field.string": { "name": "label" } } ],
                              "extends": "Base",   "name": "Gizmo" } } ],
                        "package": "verify::extra"
                      }
                    }
                    """);
            case "metadata-moved" -> {
                // The same object, same package, in a different file.
                Files.move(project.resolve("metaobjects/meta.extra.json"), project.resolve("metaobjects/meta.moved.json"));
            }
            case "parent-edited" -> Files.writeString(project.resolve("metaobjects/meta.base.json"), """
                    {"metadata.root": {"package": "verify::extra", "children": [
                      {"object.entity": {"name": "Base", "abstract": true, "children": [
                        {"field.long": {"name": "id"}}, {"field.long": {"name": "createdAt"}} ]}}
                    ]}}
                    """);
            case "metadata-edited" -> {
                Path f = project.resolve("metaobjects/meta.shop.json");
                Files.writeString(f, Files.readString(f).replace("\"quantity\"", "\"quantity2\""));
            }
            case "metadata-added" -> Files.writeString(project.resolve("metaobjects/meta.more.json"), """
                    {"metadata.root": {"package": "verify::more", "children": [
                      {"object.entity": {"name": "Doohickey", "children": [ {"field.long": {"name": "id"}} ]}}
                    ]}}
                    """);
            case "metadata-removed" -> Files.delete(project.resolve("metaobjects/meta.extra.json"));
            case "config-edited" -> content = "y";
            case "project-config-edited" ->
                Files.writeString(project.resolve(".metaobjects/config.json"),
                        "{\n  \"schema_version\": 1\n}\n\n");
            case "template-edited" -> Files.writeString(project.resolve("tpl/a.mustache"), "template A");
            case "template-added" -> Files.writeString(project.resolve("tpl/b.mustache"), "b");
            case "owned-generator-edited" -> Files.writeString(project.resolve("codegen/Gen.java"), "class Gen2 {}");
            case "engine-changed" -> Files.writeString(engine.resolve("engine.class"), "v2");
            case "selection-changed" -> lax = true;
            case "declared-extra-edited" -> Files.writeString(project.resolve("lookup.txt"), "lookup 2");
            case "uncacheable-generator" -> { }   // set up before the first run
            case "legacy-manifest" -> {
                // Put the manifest back in its pre-1.3.0 form: every file of .hashes/ merged into one .hashes.json.
                Path gs = project.resolve(".metaobjects/.gen-state");
                assertTrue("a package manifest exists after the first run", Files.isDirectory(gs.resolve(".hashes")));
                JsonObject merged = new JsonObject();
                try (var s = Files.list(gs.resolve(".hashes"))) {
                    for (Path f : s.sorted().toList()) {
                        for (var e : JsonParser.parseString(Files.readString(f)).getAsJsonObject().entrySet()) {
                            merged.add(e.getKey(), e.getValue());
                        }
                    }
                }
                Files.writeString(gs.resolve(".hashes.json"), merged + "\n");
                deleteTree(gs.resolve(".hashes"));
                Files.delete(gs.resolve(".hashes"));
            }
            case "generated-file-deleted" -> Files.delete(project.resolve("gen/Out.java"));
            case "generated-file-edited" -> Files.writeString(project.resolve("gen/Out.java"),
                    Files.readString(project.resolve("gen/Out.java")) + "// hand edit\n");
            case "hand-edit-kept" -> {
                Files.writeString(project.resolve("gen/Out.java"),
                        Files.readString(project.resolve("gen/Out.java")) + "// hand edit\n");
                gen(false);   // renders, keeps the edit, and stores the key with the file as it now is
                assertTrue("the run kept the edit", Files.readString(project.resolve("gen/Out.java")).contains("hand edit"));
                assertTrue("a key was stored after the kept edit", hasFingerprint());
            }
            case "fingerprint-missing" -> {
                try (var s = Files.list(project.resolve(".metaobjects/.gen-state"))) {
                    for (Path p : s.filter(p -> p.getFileName().toString().startsWith(".fingerprint-")).toList()) {
                        Files.delete(p);
                    }
                }
            }
            case "force", "ci" -> { }
            case "failed-run" -> {
                Path f = project.resolve("metaobjects/meta.shop.json");
                String original = Files.readString(f);
                Files.writeString(f, original.replace("\"quantity\"", "\"quantity3\""));
                FixtureGenerator.fail = true;
                try {
                    gen(false);
                    fail("the failing run must fail");
                } catch (RuntimeException expected) {
                    // the run started after an input change and failed
                }
                FixtureGenerator.fail = false;
                Files.writeString(f, original);   // restored to what the last good run saw
            }
            default -> fail("unknown case id '" + id + "': this runner must handle every id in cases.json");
        }
    }

    @Test
    public void everyCaseInTheSharedTable() throws Exception {
        JsonObject table = JsonParser.parseString(Files.readString(CASES)).getAsJsonObject();
        int ran = 0;
        for (JsonElement el : table.getAsJsonArray("cases")) {
            JsonObject c = el.getAsJsonObject();
            String id = c.get("id").getAsString();
            runCase(id, c.get("gen").getAsString(), c.get("verify").getAsString());
            ran++;
        }
        assertTrue(ran > 0);
    }

    private void runCase(String id, String expectGen, String expectVerify) throws Exception {
        // Each case starts from a fresh project and a fresh run.
        tearDown();
        setUp0();
        if (id.equals("uncacheable-generator")) FixtureGenerator.cacheable = false;
        FixtureGenerator.extra = project.resolve("lookup.txt");
        gen(false);
        assertTrue(id + ": the first run writes", FixtureGenerator.runs == 1);
        assertTrue(id + ": the first run writes a file", Files.isRegularFile(project.resolve("gen/Out.java")));
        boolean stored = hasFingerprint();
        assertEquals(id + ": a fingerprint is stored exactly when every generator is cacheable",
                !id.equals("uncacheable-generator"), stored);

        applyChange(id);
        if (id.equals("ci")) ci = "true";
        verifyFull = id.equals("force");

        // The verify decision comes first: it writes nothing, so gen then sees the same state.
        int rendered = verifyRenders();
        if (expectVerify.equals("may-answer-no-drift")) {
            // "may": answering from the fingerprint is allowed; this port does it.
            assertEquals(id + ": local verify answers without rendering", 0, rendered);
        } else {
            assertTrue(id + ": verify must render", rendered > 0);
        }
        ci = null;
        verifyFull = false;
        if (id.equals("legacy-manifest")) {
            Path gs = project.resolve(".metaobjects/.gen-state");
            assertTrue("a read-only verify migrates nothing", Files.isRegularFile(gs.resolve(".hashes.json")));
            assertFalse("a read-only verify writes no package manifest", Files.exists(gs.resolve(".hashes")));
        }

        int before = FixtureGenerator.runs;
        gen(id.equals("force"));
        boolean ran = FixtureGenerator.runs > before;
        assertEquals(id + ": gen " + expectGen, expectGen.equals("regenerate"), ran);
        if (id.equals("legacy-manifest")) {
            Path gs = project.resolve(".metaobjects/.gen-state");
            assertFalse("the write run removed the legacy manifest", Files.exists(gs.resolve(".hashes.json")));
            assertTrue("and left package manifests", Files.isRegularFile(gs.resolve(".hashes/.root.json")));
        }
    }

    private void setUp0() throws IOException {
        // A fresh temp project per case: wipe and rebuild.
        deleteTree(project);
        Files.createDirectories(project);
        Files.createDirectories(engine);
        FixtureGenerator.runs = 0;
        FixtureGenerator.fail = false;
        FixtureGenerator.cacheable = true;
        setUpFiles();
    }

    private void setUpFiles() throws IOException {
        Files.createDirectories(project.resolve("metaobjects"));
        Files.copy(Path.of("src/test/resources/mojo/verify-test-metadata.json"),
                project.resolve("metaobjects/meta.shop.json"));
        Files.writeString(project.resolve("metaobjects/meta.base.json"), """
                {"metadata.root": {"package": "verify::extra", "children": [
                  {"object.entity": {"name": "Base", "abstract": true, "children": [ {"field.long": {"name": "id"}} ]}}
                ]}}
                """);
        Files.writeString(project.resolve("metaobjects/meta.extra.json"), """
                {"metadata.root": {"package": "verify::extra", "children": [
                  {"object.entity": {"name": "Gizmo", "extends": "Base", "children": [ {"field.string": {"name": "label"}} ]}}
                ]}}
                """);
        Files.createDirectories(project.resolve("tpl"));
        Files.writeString(project.resolve("tpl/a.mustache"), "template a");
        Files.createDirectories(project.resolve("codegen"));
        Files.writeString(project.resolve("codegen/Gen.java"), "class Gen {}");
        Files.writeString(project.resolve("lookup.txt"), "lookup");
        Files.writeString(project.resolve("README.md"), "readme");
        Files.createDirectories(project.resolve(".metaobjects"));
        Files.writeString(project.resolve(".metaobjects/config.json"), "{\n  \"schema_version\": 1\n}\n");
        Files.writeString(engine.resolve("engine.class"), "v1");
        content = "x";
        lax = false;
        ci = null;
    }

    private boolean hasFingerprint() throws IOException {
        Path dir = project.resolve(".metaobjects/.gen-state");
        if (!Files.isDirectory(dir)) return false;
        try (var s = Files.list(dir)) {
            return s.anyMatch(p -> p.getFileName().toString().startsWith(".fingerprint-java-"));
        }
    }

    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (var walk = Files.walk(root)) {
            for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                if (!p.equals(root)) Files.delete(p);
            }
        }
    }
}
