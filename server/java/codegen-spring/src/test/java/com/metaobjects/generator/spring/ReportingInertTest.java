package com.metaobjects.generator.spring;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.GeneratorRegistry.GeneratorInfo;
import com.metaobjects.generator.apidocs.ApiUnit;
import com.metaobjects.generator.apidocs.DocsPaths;
import com.metaobjects.generator.apidocs.JavaApiDocsRenderer;
import com.metaobjects.generator.apidocs.JavaApiModel;
import com.metaobjects.generator.apidocs.JavaApiModelBuilder;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FR-044 Plan 1 — the reporting vocabulary is INERT in every Java generator.
 *
 * <p>Plan 1 registers {@code dimension.*}, {@code measure.*}, {@code segment.*} and
 * {@code object.report} and validates them at load, but gives none of them output: a
 * report's lowering lands in Plan 2/3. Until then a model that USES the vocabulary must
 * generate exactly what the same model without it generates, byte for byte, through every
 * generator in {@link GeneratorRegistry}.
 *
 * <p>The model pair is {@code fixtures/codegen-noop/reporting/{with,without}}, shared with the
 * other four ports' copies of this test. {@code with/} carries a report that declares a
 * read-only {@code source.rdb @kind: view} (R5 allows one) — the shape that leaked in C#.
 */
public class ReportingInertTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String THREW = "<threw>";
    private static final java.util.regex.Pattern GENERATED_ON =
        java.util.regex.Pattern.compile("Generated On:[^\\n]*");

    private static Path model(String variant) {
        return SpringTestFixtures.findCorpusRoot().getParent()
            .resolve("codegen-noop/reporting/" + variant + "/meta.shop.json");
    }

    private MetaDataLoader load(String variant) throws Exception {
        String json = Files.readString(model(variant), StandardCharsets.UTF_8);
        // One loader name for both variants: the model tier stamps it into generated code.
        return SpringTestFixtures.loadFixture(tempFolder.newFolder().toPath(), "shop", json);
    }

    private static Generator instantiate(GeneratorInfo info) throws Exception {
        return (Generator) Class.forName(info.classname()).getDeclaredConstructor().newInstance();
    }

    /**
     * Run a generator suite into a fresh directory and read back every file it wrote:
     * relative path to contents. A throw is recorded as the single entry {@code <threw>}, so a
     * generator that cannot run from a bare model must at least fail identically.
     */
    private Map<String, String> emit(String variant, List<GeneratorInfo> suite) throws Exception {
        MetaDataLoader loader = load(variant);
        Path outDir = tempFolder.newFolder().toPath();
        Map<String, String> files = new TreeMap<>();
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for (GeneratorInfo info : suite) {
                Generator gen = instantiate(info);
                run.attributeTo(gen.getClass().getSimpleName());
                Map<String, String> args = new LinkedHashMap<>();
                args.put("outputDir", outDir.toString());
                args.put("templateRoot", tempFolder.newFolder().toString());
                // The model generator needs its emission shape named; this is the one
                // CodegenCompileConformanceTest compiles.
                if ("entity".equals(info.stableName())) {
                    args.put("type", "class");
                    args.put("flavor", "pojoAware");
                }
                gen.setArgs(args).execute(loader);
            }
        } catch (Exception | LinkageError e) {
            files.clear();
            files.put(THREW, String.valueOf(e.getMessage()));
            return files;
        }
        try (Stream<Path> s = Files.walk(outDir)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                // The model tier stamps a wall-clock "Generated On:" line into every class
                // header; two runs a second apart differ there and nowhere else by design.
                files.put(outDir.relativize(p).toString(),
                    GENERATED_ON.matcher(Files.readString(p, StandardCharsets.UTF_8)).replaceAll("Generated On: <time>"));
            }
        }
        return files;
    }

    private static void assertSame(String label, Map<String, String> expected, Map<String, String> actual) {
        assertEquals(label + ": emitted file set", new ArrayList<>(expected.keySet()), new ArrayList<>(actual.keySet()));
        for (Map.Entry<String, String> e : expected.entrySet()) {
            assertEquals(label + ": " + e.getKey() + " differs once reporting nodes are declared",
                e.getValue(), actual.get(e.getKey()));
        }
    }

    @Test
    public void theWithModelReallyCarriesTheVocabulary() throws Exception {
        // Else every comparison below is vacuously green.
        List<String> reports = new ArrayList<>();
        for (MetaObject mo : load("with").getMetaObjects()) {
            if ("report".equals(mo.getSubType())) reports.add(mo.getShortName());
        }
        reports.sort(null);
        assertEquals(List.of("DailyRevenue", "ProgramEngagement", "StoreTotals"), reports);
        for (MetaObject mo : load("without").getMetaObjects()) {
            assertFalse("without-model declares a report", "report".equals(mo.getSubType()));
        }
    }

    @Test
    public void everyGeneratorEmitsTheSameFilesWithAndWithoutReportingNodes() throws Exception {
        // Every generator is compared before anything is asserted, so one red run names
        // every leak rather than the first.
        List<String> leaks = new ArrayList<>();
        for (GeneratorInfo info : GeneratorRegistry.list().values()) {
            try {
                assertSame(info.stableName(), emit("without", List.of(info)), emit("with", List.of(info)));
            } catch (AssertionError e) {
                leaks.add(e.getMessage());
            }
        }
        assertTrue(String.join("\n", leaks), leaks.isEmpty());
    }

    @Test
    public void theModelAndWebTiersInOneRunEmitTheSameFiles() throws Exception {
        // entity and value-object both claim an object.value's path, so they are two
        // coherent halves (see CodegenCompileConformanceTest), each run as one program.
        Map<String, GeneratorInfo> all = GeneratorRegistry.list();
        for (List<String> tier : List.of(
                List.of("entity", "names"),
                List.of("value-object", "dto", "repository", "filter-allowlist", "routes", "names"))) {
            List<GeneratorInfo> suite = tier.stream().map(all::get).collect(Collectors.toList());
            Map<String, String> expected = emit("without", suite);
            assertFalse(tier + " threw: " + expected.get(THREW), expected.containsKey(THREW));
            assertTrue(tier + ": only " + expected.size() + " files — the suite barely ran", expected.size() >= 3);
            assertSame(tier.toString(), expected, emit("with", suite));
        }
    }

    /**
     * The api docs surface ({@code mvn metaobjects:docs}): every unit page, the index and the
     * agent page. A report has no generated API to document, and its derived fields do not
     * exist until its lowering lands.
     */
    private Map<String, String> apiDocs(String variant) throws Exception {
        JavaApiModel model = new JavaApiModelBuilder().build(load(variant), "shop");
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();
        Map<String, String> pages = new TreeMap<>();
        for (ApiUnit unit : model.units()) {
            pages.put(DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, unit.pkg(), unit.node()),
                renderer.renderUnitPage(unit, null));
        }
        pages.put("README.md", renderer.renderIndex(model, DocsPaths.Layout.PACKAGE));
        pages.put("AGENT-API.md", renderer.renderAgentApi(model));
        return pages;
    }

    @Test
    public void apiDocsAreTheSameWithAndWithoutReportingNodes() throws Exception {
        Map<String, String> expected = apiDocs("without");
        assertTrue("only " + expected.size() + " pages — the docs barely ran", expected.size() > 3);
        assertSame("api docs", expected, apiDocs("with"));
    }
}
