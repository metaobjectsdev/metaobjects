package com.metaobjects.generator.spring;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.config.DependencySet;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FR-023 — a node a metadata DEPENDENCY owns is loaded (the project's own nodes extend and
 * reference it) but is another project's to generate. This runs every Spring-tier generator over
 * a project that imports a shared model through the committed snapshot and asserts none of them
 * writes a file, or a line, for an imported node — the Java counterpart of the TypeScript and
 * Python selection points. The project and its snapshot come from the shared
 * {@code fixtures/dependency-conformance} corpus, so the model is the one the other ports load.
 */
public class DependencyImportExclusionTest extends SharedRegistryTestBase {

    private static final String CASE = "a-dependency-adds-its-artifact-to-the-resolved-set";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/dependency-conformance");
    }

    /** Materialize the corpus case as a project directory; returns the project root. */
    private Path materialize() throws Exception {
        JsonObject all = JsonParser.parseString(
                Files.readString(corpus().resolve("cases.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject c = null;
        for (JsonElement el : all.getAsJsonArray("cases")) {
            if (CASE.equals(el.getAsJsonObject().get("name").getAsString())) c = el.getAsJsonObject();
        }
        assertTrue("corpus case missing: " + CASE, c != null);
        Path root = tempFolder.newFolder("project").toPath();
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
            write(root.resolve(e.getKey()), e.getValue().getAsString().getBytes(StandardCharsets.UTF_8));
        }
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("treeFiles").entrySet()) {
            write(root.resolve(e.getKey()), Files.readAllBytes(corpus().resolve(e.getValue().getAsString())));
        }
        write(root.resolve(".metaobjects/config.json"), c.getAsJsonObject("config").toString().getBytes(StandardCharsets.UTF_8));
        write(root.resolve(".metaobjects/deps.lock.json"), c.getAsJsonObject("lock").toString().getBytes(StandardCharsets.UTF_8));
        return root;
    }

    private static void write(Path p, byte[] bytes) throws Exception {
        Files.createDirectories(p.getParent());
        Files.write(p, bytes);
    }

    @Test
    public void noGeneratorEmitsForAnImportedNode() throws Exception {
        Path root = materialize();
        com.metaobjects.config.SourceResolver.ResolvedCollection collection =
                com.metaobjects.config.SourceResolver.resolveCollectionWithDependencies(root);
        DependencySet deps = collection.dependencies();
        List<MetaDataSource> sources = new ArrayList<>(deps.sources());
        for (Path own : collection.ownFiles()) sources.add(new FileSource(own));

        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "dep-exclusion");
        loader.init();
        loader.setDependencies(deps);
        loader.load(sources);
        assertTrue("the imported model is part of the loaded graph",
                loader.getMetaObjects().stream().anyMatch(o -> o.getName().equals("acme::common::Customer")));

        Path outDir = tempFolder.newFolder("gen").toPath();
        List<Generator> generators = List.of(
                new JavaObjectCodeGenerator(), new ExtractorCodeGenerator(),
                new SpringValueObjectGenerator(), new SpringDtoGenerator(),
                new SpringRepositoryGenerator(), new SpringFilterAllowlistGenerator(),
                new SpringNamesGenerator(), new SpringControllerGenerator(),
                new SpringReportExportGenerator(), new LlmTraceHelperGenerator(),
                new SpringOutputParserGenerator(), new SpringOutputPromptGenerator(),
                new SpringRenderHelperGenerator());
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (Generator gen : generators) {
                run.attributeTo(gen.getClass().getSimpleName());
                gen.setArgs(Map.of("outputDir", outDir.toString(), "type", "class", "flavor", "pojoAware",
                        "templateRoot", SpringTestFixtures.findCorpusRoot().resolve("canonical/prompts").toString()))
                    .execute(loader);
            }
        }

        List<Path> files;
        try (Stream<Path> s = Files.walk(outDir)) {
            files = s.filter(Files::isRegularFile).collect(Collectors.toList());
        }
        assertTrue("the project's own Order must still generate: " + files,
                files.stream().anyMatch(p -> p.getFileName().toString().startsWith("Order")));
        for (Path f : files) {
            String rel = outDir.relativize(f).toString();
            assertFalse("a file was emitted for an imported node: " + rel,
                    rel.contains("acme") || rel.contains("Customer") || rel.contains("Address"));
            String body = Files.readString(f, StandardCharsets.UTF_8);
            assertFalse(rel + " mentions an imported node", body.contains("Customer") || body.contains("acme::common"));
        }
    }
}
