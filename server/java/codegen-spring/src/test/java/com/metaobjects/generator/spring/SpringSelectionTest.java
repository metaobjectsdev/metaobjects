package com.metaobjects.generator.spring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.stream.Stream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Selection in the Java port: a generator's {@code <filters>} and the run's entity selection
 * ({@code -Dmeta.entities}) both narrow the objects it writes files for, over the shared
 * canonical model.
 *
 * <p>Until 1.3.0 every generator in this module iterated the whole model and ignored
 * {@code <filters>}: only the older generators in {@code codegen-base} honoured them. The
 * selection here names an entity ({@code Person}), a value object ({@code Settings}) and a
 * served report ({@code ProgramMinutes}), so each generator has something to emit.</p>
 */
public class SpringSelectionTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final List<String> SELECTED = List.of("Person", "Settings", "ProgramMinutes");
    private static final List<String> FILTERS =
        List.of("fitness::Person", "fitness::Settings", "fitness::ProgramMinutes");

    /** Objects outside the selection: no file may be named after one in a narrowed run. */
    private static final List<String> UNSELECTED = List.of("Week", "Tag", "AllTypes", "Gadget", "Post", "Asset", "Session");

    private static Map<String, Supplier<Generator>> generators() {
        Map<String, Supplier<Generator>> g = new LinkedHashMap<>();
        g.put("entity", () -> new JavaObjectCodeGenerator().setArgs(Map.of("type", "class", "flavor", "pojoAware")));
        g.put("extractor", ExtractorCodeGenerator::new);
        g.put("value-object", SpringValueObjectGenerator::new);
        g.put("dto", SpringDtoGenerator::new);
        g.put("repository", SpringRepositoryGenerator::new);
        g.put("filter-allowlist", SpringFilterAllowlistGenerator::new);
        g.put("names", SpringNamesGenerator::new);
        g.put("controller", SpringControllerGenerator::new);
        g.put("report-export", SpringReportExportGenerator::new);
        return g;
    }

    /** Run every generator over the canonical model; return each file's relative path and content. */
    private Map<String, String> generate(String label, Consumer<Generator> narrow) throws Exception {
        String canonicalMeta = Files.readString(
            SpringTestFixtures.findCorpusRoot().resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);
        Path outDir = tempFolder.newFolder("gen-" + label).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tempFolder.newFolder("ws-" + label).toPath(), "fitness", canonicalMeta);
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (Map.Entry<String, Supplier<Generator>> e : generators().entrySet()) {
                Generator gen = e.getValue().get();
                run.attributeTo(gen.getClass().getSimpleName());
                // Its own directory each: the entity and value-object tiers both write a
                // class per value object, and this test compares outputs, not a project.
                gen.setArgs(Map.of("outputDir", outDir.resolve(e.getKey()).toString()));
                narrow.accept(gen);
                gen.execute(loader);
            }
        }
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> s = Files.walk(outDir)) {
            for (Path p : (Iterable<Path>) s.filter(Files::isRegularFile)::iterator) {
                out.put(outDir.relativize(p).toString(), Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return out;
    }

    /**
     * @param wholeModelUnchanged true for the entity selection, which must leave every
     *        whole-model file exactly as a full run writes it; false for {@code <filters>},
     *        which narrow what a whole-model file covers as well
     */
    private static void assertNarrowed(String how, Map<String, String> full, Map<String, String> narrowed,
                                       boolean wholeModelUnchanged) {
        assertFalse(how + ": wrote nothing", narrowed.isEmpty());
        assertTrue(how + ": wrote " + narrowed.size() + " of " + full.size() + " files; expected fewer",
            narrowed.size() < full.size());
        for (Map.Entry<String, String> e : narrowed.entrySet()) {
            assertTrue(how + ": wrote " + e.getKey() + ", which a full run does not", full.containsKey(e.getKey()));
            String file = Path.of(e.getKey()).getFileName().toString();
            if (wholeModelUnchanged || SELECTED.stream().anyMatch(file::startsWith)) {
                assertEquals(how + ": " + e.getKey() + " differs from a full run", full.get(e.getKey()), e.getValue());
            }
            for (String other : UNSELECTED) {
                assertFalse(how + ": wrote " + e.getKey() + " for an object outside the selection",
                    file.startsWith(other));
            }
        }
        for (String name : SELECTED) {
            assertTrue(how + ": wrote no file for " + name,
                narrowed.keySet().stream().anyMatch(k -> Path.of(k).getFileName().toString().startsWith(name)));
        }
        // The export writer is shared by every served report, so a narrowed run still writes it whole.
        assertTrue(how + ": the shared ReportExportWriter is missing",
            narrowed.keySet().stream().anyMatch(k -> k.endsWith("ReportExportWriter.java")));
        // So are the controller's per-package wire support classes.
        assertTrue(how + ": a per-object controller is missing",
            narrowed.keySet().stream().anyMatch(k -> k.endsWith("PersonController.java")));
    }

    @Test
    public void filtersNarrowEveryGenerator() throws Exception {
        Map<String, String> full = generate("full", g -> { });
        Map<String, String> filtered = generate("filtered", g -> g.setFilters(FILTERS));
        assertNarrowed("<filters>", full, filtered, false);
    }

    @Test
    public void theEntitySelectionNarrowsPerObjectOutput() throws Exception {
        Map<String, String> full = generate("full", g -> { });
        Map<String, String> selected = generate("selected", g -> ((GeneratorBase) g).setEntities(SELECTED));
        assertNarrowed("entities", full, selected, true);
    }

    @Test
    public void anEmptySelectionSelectsEverything() throws Exception {
        Map<String, String> full = generate("full", g -> { });
        Map<String, String> unnarrowed = generate("unnarrowed", g -> ((GeneratorBase) g).setEntities(List.of()));
        assertEquals(full, unnarrowed);
    }
}
