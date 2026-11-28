package com.metaobjects.docs.explorer;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.docsview.DocsView;
import com.metaobjects.docsview.DocsViewConformanceTest;
import com.metaobjects.generator.DocsSiteGenerator;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The explorer site the JVM {@code docs-site} generator writes: the same files, and the same data
 * script bytes, as TypeScript's {@code generateExplorerSite} ({@code output: "app"}).
 */
public class ExplorerSiteTest {

    @Rule public TemporaryFolder temp = new TemporaryFolder();

    static Path repo() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures/explorer-conformance")) && Files.isDirectory(p.resolve("explorer-app"))) return p;
        }
        throw new IllegalStateException("repository root not found above " + Path.of("").toAbsolutePath());
    }

    static Path fixture(String name) {
        return repo().resolve("fixtures/explorer-conformance").resolve(name);
    }

    static JsonObject expectedView(String name) throws IOException {
        return JsonParser.parseString(Files.readString(fixture(name).resolve("expected.json"))).getAsJsonObject();
    }

    static String sha256(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void modelScriptIsTypeScriptsBytes() throws Exception {
        Map<String, String> texts = new LinkedHashMap<>();
        texts.put("b", "B\n");
        texts.put("a", "A é");
        ExplorerSite.ModelScript m = ExplorerSite.modelScript("Shop  <x>", "v1", texts,
            Map.of("explorer-head.mustache", "<h>"), expectedView("shop"));
        // explorerModelScript({ title: "Shop  <x>", footer: "v1", texts, templates, view })
        // in @metaobjectsdev/docs-site, over the same shop view, gives this stamp and these bytes.
        assertEquals("05b57283a47416e2", m.stamp());
        assertEquals(50657, m.script().length());
        assertEquals("02f2d4321101c0ab9fa9e22db542ff8f71f1e952748e8f894d388bd43feeb6bc", sha256(m.script()));
        assertEquals("window.MO_STAMP = \"05b57283a47416e2\";\n", ExplorerSite.stampScript(m.stamp()));
    }

    @Test
    public void appFilesAreTheCanonicalCopy() throws IOException {
        Map<String, String> files = ExplorerSite.emit(new ExplorerSite.Input(expectedView("model-alone"), "t", "", Map.of(), null, null));
        for (String f : ExplorerSite.APP_FILES) {
            assertEquals(f, Files.readString(repo().resolve("explorer-app").resolve(f)), files.get(f));
        }
        assertEquals(Files.readString(fixture("model-alone").resolve("expected.json")), files.get(ExplorerSite.VIEW_FILE));
        assertEquals(List.of("index.html", "assets/explorer-app.js", "assets/cytoscape.min.js", "assets/3d-force-graph.min.js",
                "assets/explorer.css", "assets/explorer.js", "explorer-model.js", "explorer-stamp.js", "explorer.json"),
            List.copyOf(files.keySet()));
    }

    @Test
    public void anOwnedThemeAndTemplateWin() throws IOException {
        Path dir = temp.newFolder().toPath();
        Files.createDirectories(dir.resolve("assets"));
        Files.createDirectories(dir.resolve("templates"));
        Files.writeString(dir.resolve("assets/explorer.css"), "body{}");
        Files.writeString(dir.resolve("templates/explorer-head.mustache"), "<owned>");
        Files.writeString(dir.resolve("templates/not-a-template.mustache"), "ignored");
        Map<String, String> files = ExplorerSite.emit(new ExplorerSite.Input(expectedView("model-alone"), "t", "", Map.of(),
            dir.resolve("assets"), dir.resolve("templates")));
        assertEquals("body{}", files.get("assets/explorer.css"));
        assertEquals(Files.readString(repo().resolve("explorer-app/assets/explorer.js")), files.get("assets/explorer.js"));
        String model = files.get(ExplorerSite.MODEL_FILE);
        assertTrue("owned template carried", model.contains("\"templates\":{\"explorer-head.mustache\":\"<owned>\"}"));
    }

    @Test
    public void promptTextsReadBelowTheDirectoriesOnly() throws IOException {
        Path dir = temp.newFolder().toPath();
        JsonObject view = expectedView("shop");
        Map<String, String> texts = ExplorerSite.readPromptTexts(view, List.of(dir, fixture("shop").resolve("project/prompts")));
        assertEquals(1, texts.size());
        assertEquals(Files.readString(fixture("shop").resolve("project/prompts/shop/order-note.mustache")),
            texts.values().iterator().next());

        JsonObject climbing = JsonParser.parseString(view.toString().replace("\"shop/order-note\"", "\"../order-note\"")).getAsJsonObject();
        assertEquals(Map.of(), ExplorerSite.readPromptTexts(climbing, List.of(fixture("shop").resolve("project/prompts/shop"))));
    }

    @Test
    public void generatorWritesTheSiteFromTheLoadedModel() throws IOException {
        Path out = temp.newFolder().toPath();
        Path project = fixture("model-alone").resolve("project");
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "docs_site_generator");
        loader.init();
        loader.load(new DirectorySource(project.resolve("metaobjects"), new DirectorySource.Options()).expandToList());
        assertTrue("clean load expected: " + loader.getErrors(), loader.getErrors().isEmpty());

        DocsSiteGenerator g = new DocsSiteGenerator();
        g.setArgs(Map.of("outputDir", out.toString(), DocsSiteGenerator.ARG_PROJECT_ROOT, project.toString()));
        g.execute(loader);

        assertEquals(Files.readString(fixture("model-alone").resolve("expected.json")),
            Files.readString(out.resolve("site/explorer.json")));
        assertEquals(DocsView.serialize(DocsView.build(loader.getRoot())), Files.readString(out.resolve("site/explorer.json")));
        String model = Files.readString(out.resolve("site/explorer-model.js"));
        assertTrue(model.substring(0, 40), model.startsWith("window.MO_MODEL = {\"stamp\":"));
        assertTrue("title defaults to the project directory's name", model.contains("\"title\":\"project\""));
        for (String f : ExplorerSite.APP_FILES) assertTrue(f, Files.isRegularFile(out.resolve("site").resolve(f)));
    }

    @Test
    public void generatorListsTheFilesTheManifestRecords() throws IOException {
        Path tmp = temp.newFolder().toPath();
        Path project = fixture("shop").resolve("project");
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "docs_site_generator_shop");
        loader.init();
        loader.load(new DirectorySource(project.resolve("metaobjects"), new DirectorySource.Options()).expandToList());
        assertTrue("clean load expected: " + loader.getErrors(), loader.getErrors().isEmpty());

        // The fixture's hashes.json is the single-file manifest form HashManifest still reads.
        Path genState = tmp.resolve("gen-state");
        Files.createDirectories(genState);
        Files.copy(fixture("shop").resolve("hashes.json"), genState.resolve(".hashes.json"));

        DocsSiteGenerator g = new DocsSiteGenerator();
        g.setArgs(Map.of("outputDir", tmp.resolve("out").toString(), DocsSiteGenerator.ARG_PROJECT_ROOT, project.toString(),
            DocsSiteGenerator.ARG_GEN_STATE_DIR, genState.toString(), DocsSiteGenerator.ARG_SUB_DIR, "",
            DocsSiteGenerator.ARG_PROMPTS, "prompts",
            DocsSiteGenerator.ARG_VERIFY_FILE, fixture("shop").resolve("verify.json").toString()));
        g.execute(loader);

        JsonObject built = DocsView.build(loader.getRoot(),
            JsonParser.parseString(Files.readString(fixture("shop").resolve("verify.json"))),
            JsonParser.parseString(Files.readString(fixture("shop").resolve("hashes.json"))), null);
        assertEquals(DocsView.serialize(built), Files.readString(tmp.resolve("out/explorer.json")));
        assertTrue(Files.readString(tmp.resolve("out/explorer.json")).contains("\"generatedBy\": \"queries\""));
        assertTrue("prompt text carried", Files.readString(tmp.resolve("out/explorer-model.js")).contains("\"texts\":{\""));
    }

    /**
     * The generator's args for one corpus case: its project, its verify payload and routes when
     * present, and its hashes.json as the gen-state manifest (the single-file form HashManifest
     * still reads). The Kotlin suite runs the same case set through its registry.
     */
    public static Map<String, String> corpusArgs(String name, Path tmp) throws IOException {
        Path dir = DocsViewConformanceTest.corpus().resolve(name);
        Path genState = tmp.resolve("gen-state");
        Files.createDirectories(genState);
        if (Files.isRegularFile(dir.resolve("hashes.json"))) Files.copy(dir.resolve("hashes.json"), genState.resolve(".hashes.json"));
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", tmp.resolve("out").toString());
        args.put(DocsSiteGenerator.ARG_PROJECT_ROOT, dir.resolve("project").toString());
        args.put(DocsSiteGenerator.ARG_GEN_STATE_DIR, genState.toString());
        if (Files.isRegularFile(dir.resolve("verify.json"))) args.put(DocsSiteGenerator.ARG_VERIFY_FILE, dir.resolve("verify.json").toString());
        if (Files.isRegularFile(dir.resolve("routes.json"))) args.put(DocsSiteGenerator.ARG_ROUTES_FILE, dir.resolve("routes.json").toString());
        return args;
    }

    @Test
    public void generatorWritesEveryCorpusCaseByteForByte() throws IOException {
        for (String name : DocsViewConformanceTest.fixtures()) {
            Path tmp = temp.newFolder(name).toPath();
            DocsSiteGenerator g = new DocsSiteGenerator();
            g.setArgs(corpusArgs(name, tmp));
            g.execute(DocsViewConformanceTest.load(name));
            assertEquals(name, Files.readString(DocsViewConformanceTest.corpus().resolve(name).resolve("expected.json")),
                Files.readString(tmp.resolve("out/site/explorer.json")));
        }
    }
}
