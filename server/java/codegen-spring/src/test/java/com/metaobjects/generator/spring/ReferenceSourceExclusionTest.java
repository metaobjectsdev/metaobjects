package com.metaobjects.generator.spring;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.config.SourceResolver;
import com.metaobjects.generator.Generator;
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
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A node declared only by a REFERENCE source ({@code {"path": ..., "reference": true}}) loads and
 * resolves but is another run's to generate: no value-object record is written for it (nor for a
 * reference value object it nests), while the output parser of a LOCAL prompt whose
 * {@code @responseRef} names it still emits, naming the reply type the owning run generates. The
 * project and its sources come from the shared {@code fixtures/reference-source-conformance} corpus.
 */
public class ReferenceSourceExclusionTest extends SharedRegistryTestBase {

    private static final String CASE = "reply-type-in-a-reference-source-resolves-and-is-not-generated";
    private static final String REFERENCE_ID_PREFIX = "ref:";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/reference-source-conformance/cases.json");
    }

    private Path materialize() throws Exception {
        JsonObject all = JsonParser.parseString(Files.readString(corpus(), StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject c = null;
        for (JsonElement el : all.getAsJsonArray("cases")) {
            if (CASE.equals(el.getAsJsonObject().get("name").getAsString())) c = el.getAsJsonObject();
        }
        assertTrue("corpus case missing: " + CASE, c != null);
        Path root = tempFolder.newFolder("project").toPath();
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
            Path p = root.resolve(e.getKey());
            Files.createDirectories(p.getParent());
            Files.writeString(p, e.getValue().getAsString(), StandardCharsets.UTF_8);
        }
        Path cfg = root.resolve(".metaobjects/config.json");
        Files.createDirectories(cfg.getParent());
        Files.writeString(cfg, c.getAsJsonObject("config").toString(), StandardCharsets.UTF_8);
        return root;
    }

    @Test
    public void noGeneratorEmitsForAReferenceNodeButTheParserStillNamesIt() throws Exception {
        Path root = materialize();
        SourceResolver.ResolvedCollection collection = SourceResolver.resolveCollectionWithDependencies(root);
        List<MetaDataSource> sources = new ArrayList<>();
        Set<String> referenceIds = new TreeSet<>();
        for (Path file : collection.ownFiles()) {
            String rel = root.relativize(file).toString().replace('\\', '/');
            if (collection.referenceFiles().contains(file)) {
                referenceIds.add(REFERENCE_ID_PREFIX + rel);
                sources.add(new FileSource(file, REFERENCE_ID_PREFIX + rel));
            } else {
                sources.add(new FileSource(file));
            }
        }
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "reference-exclusion");
        loader.init();
        loader.setReferenceSourceIds(referenceIds);
        loader.load(sources);
        assertTrue("loader errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        assertEquals(Set.of("acme::support::SupportAnswer", "acme::support::AnswerSource"),
                loader.getRoot().getReferenceNodes());

        Path outDir = tempFolder.newFolder("gen").toPath();
        List<Generator> generators = List.of(
                new SpringValueObjectGenerator(), new SpringDtoGenerator(), new SpringRepositoryGenerator(),
                new SpringNamesGenerator(), new SpringControllerGenerator(),
                new SpringOutputParserGenerator(), new SpringOutputPromptGenerator());
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (Generator gen : generators) {
                run.attributeTo(gen.getClass().getSimpleName());
                gen.setArgs(Map.of("outputDir", outDir.toString(), "type", "class", "flavor", "pojoAware"))
                        .execute(loader);
            }
        }

        List<String> files;
        try (Stream<Path> s = Files.walk(outDir)) {
            files = s.filter(Files::isRegularFile).map(p -> outDir.relativize(p).toString()).sorted()
                    .collect(Collectors.toList());
        }
        assertTrue("the project's own payload record still generates: " + files,
                files.contains("acme/support/SupportRequest.java"));
        for (String f : files) {
            assertFalse("a file was emitted for a reference node: " + f,
                    f.endsWith("/SupportAnswer.java") || f.endsWith("/AnswerSource.java"));
        }
        String parserPath = files.stream().filter(f -> f.endsWith("SupportAnswerPromptParser.java")).findFirst()
                .orElseThrow(() -> new AssertionError("the local prompt's parser must still emit: " + files));
        String parser = Files.readString(outDir.resolve(parserPath), StandardCharsets.UTF_8);
        assertTrue("the parser names the reference reply type: " + parser,
                parser.contains("acme.support.SupportAnswer"));
    }
}
