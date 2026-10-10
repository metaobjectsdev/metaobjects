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
import java.util.Collection;
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
 * FR-044 — what the reporting vocabulary does and does not change in the Java generators.
 *
 * <p>{@code dimension.*}, {@code measure.*}, {@code segment.*} and a report that declares no
 * view source are INERT: a model that uses them generates exactly what the same model
 * without them generates, byte for byte, through every generator in
 * {@link GeneratorRegistry}.
 *
 * <p>Since Plan 3 a report that declares a read-only {@code source.rdb @kind: view} is
 * SERVED: the REST-surface generators emit its read-only files and nothing else changes.
 * {@code StoreTotals} is that report, so {@code with/} differs from {@code without/} in
 * exactly {@link #SERVED_REPORT_FILES} (one file per generator) and one api-docs unit.
 * {@code DailyRevenue}, {@code ProgramEngagement} and {@code ProgramCatalogue} (which declares
 * {@code @spine} and lists a dimension reached by {@code @via}) declare no source and stay
 * inert, as does a measure {@code @default} ({@code avgDaysPerStarter}).
 *
 * <p>The model pair is {@code fixtures/codegen-noop/reporting/{with,without}}, shared with the
 * other four ports' copies of this test.
 */
public class ReportingInertTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String THREW = "<threw>";

    /** The with-model's reports that declare no source: inert everywhere. */
    private static final List<String> SOURCELESS_REPORTS =
        List.of("DailyRevenue", "ProgramEngagement", "ProgramCatalogue");

    /**
     * The one file each REST-surface generator adds for the served report {@code StoreTotals}
     * (contract Table E), by generator stable name. Every generator not named here must emit
     * byte-identical output with and without the reporting nodes.
     */
    private static final Map<String, String> SERVED_REPORT_FILES = Map.of(
        "dto", "acme/shop/StoreTotalsDto.java",
        "repository", "acme/shop/StoreTotalsRepository.java",
        "filter-allowlist", "acme/shop/StoreTotalsFilterAllowlist.java",
        "routes", "acme/shop/StoreTotalsController.java");
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

    /**
     * {@link #assertSame} once {@code extras} are taken out of {@code actual}: each must be
     * there (the served report's file) and nothing else may differ.
     */
    private static void assertSameBut(String label, Map<String, String> expected, Map<String, String> actual,
            Collection<String> extras) {
        Map<String, String> rest = new TreeMap<>(actual);
        for (String extra : extras) {
            assertTrue(label + ": the served report's " + extra + " was not emitted; got " + actual.keySet(),
                rest.remove(extra) != null);
            assertFalse(label + ": " + extra + " is emitted without any report", expected.containsKey(extra));
        }
        assertSame(label, expected, rest);
    }

    @Test
    public void theWithModelReallyCarriesTheVocabulary() throws Exception {
        // Else every comparison below is vacuously green.
        List<String> reports = new ArrayList<>();
        for (MetaObject mo : load("with").getMetaObjects()) {
            if (MetaObject.SUBTYPE_REPORT.equals(mo.getSubType())) reports.add(mo.getShortName());
        }
        reports.sort(null);
        assertEquals(List.of("DailyRevenue", "ProgramCatalogue", "ProgramEngagement", "StoreTotals"), reports);
        for (MetaObject mo : load("without").getMetaObjects()) {
            assertFalse("without-model declares a report", MetaObject.SUBTYPE_REPORT.equals(mo.getSubType()));
        }
    }

    @Test
    public void everyGeneratorEmitsTheSameFilesButTheServedReportsOwn() throws Exception {
        // Every generator is compared before anything is asserted, so one red run names
        // every leak rather than the first.
        List<String> leaks = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        for (GeneratorInfo info : GeneratorRegistry.list().values()) {
            String extra = SERVED_REPORT_FILES.get(info.stableName());
            if (extra != null) seen.add(info.stableName());
            try {
                assertSameBut(info.stableName(), emit("without", List.of(info)), emit("with", List.of(info)),
                    extra == null ? List.of() : List.of(extra));
            } catch (AssertionError e) {
                leaks.add(e.getMessage());
            }
        }
        assertTrue(String.join("\n", leaks), leaks.isEmpty());
        seen.sort(null);
        assertEquals("every generator SERVED_REPORT_FILES names is registered under that name",
            new ArrayList<>(new java.util.TreeSet<>(SERVED_REPORT_FILES.keySet())), seen);
    }

    @Test
    public void noGeneratorEmitsAnythingForASourcelessReport() throws Exception {
        for (GeneratorInfo info : GeneratorRegistry.list().values()) {
            for (String path : emit("with", List.of(info)).keySet()) {
                assertFalse(info.stableName() + " emitted " + path,
                    SOURCELESS_REPORTS.stream().anyMatch(path::contains));
            }
        }
    }

    @Test
    public void exactlyTheseGeneratorsCannotRunFromABareModel() throws Exception {
        // Each is compared above on its error message alone, which proves nothing about its
        // output. Pinned by name so a generator that starts throwing cannot drop out
        // silently; the list may only shrink.
        //   extractor  not a Generator at all: fused into `entity`, which emits it
        //   template   needs a `template` arg (no default template exists)
        List<String> threw = new ArrayList<>();
        StringBuilder why = new StringBuilder();
        for (GeneratorInfo info : GeneratorRegistry.list().values()) {
            Map<String, String> out = emit("without", List.of(info));
            if (out.containsKey(THREW)) {
                threw.add(info.stableName());
                why.append(info.stableName()).append(": ").append(out.get(THREW)).append('\n');
            }
        }
        threw.sort(null);
        assertEquals(why.toString(), List.of("extractor", "template"), threw);
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
            List<String> extras = tier.stream().map(SERVED_REPORT_FILES::get)
                .filter(java.util.Objects::nonNull).collect(Collectors.toList());
            assertSameBut(tier.toString(), expected, emit("with", suite), extras);
        }
    }

    /**
     * The api docs surface ({@code mvn metaobjects:docs}): every unit page, the index and the
     * agent page.
     */
    private Map<String, String> apiDocs(String variant) throws Exception {
        JavaApiModel model = new JavaApiModelBuilder().build(load(variant), "shop");
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();
        Map<String, String> pages = new TreeMap<>();
        for (ApiUnit unit : model.units()) {
            pages.put(DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, unit.pkg(), unit.node()),
                renderer.renderUnitPage(unit, null));
        }
        pages.put(INDEX_PAGE, renderer.renderIndex(model, DocsPaths.Layout.PACKAGE));
        pages.put(AGENT_PAGE, renderer.renderAgentApi(model));
        return pages;
    }

    private static final String INDEX_PAGE = "README.md";
    private static final String AGENT_PAGE = "AGENT-API.md";

    @Test
    public void apiDocsGainOneUnitForTheServedReportAndNothingElseChanges() throws Exception {
        Map<String, String> expected = apiDocs("without");
        assertTrue("only " + expected.size() + " pages — the docs barely ran", expected.size() > 3);
        Map<String, String> actual = apiDocs("with");

        // Exactly one page is new, and it is the served report's.
        List<String> added = new ArrayList<>(actual.keySet());
        added.removeAll(expected.keySet());
        assertEquals("one new page: " + added, 1, added.size());
        String reportPage = added.get(0);
        assertTrue(reportPage, reportPage.contains("StoreTotals"));
        assertTrue(actual.get(reportPage).contains("GET /api/store_totals"));

        // Every unit page that existed is byte-identical.
        for (Map.Entry<String, String> e : expected.entrySet()) {
            if (INDEX_PAGE.equals(e.getKey()) || AGENT_PAGE.equals(e.getKey())) continue;
            assertEquals("api docs: " + e.getKey() + " differs once reporting nodes are declared",
                e.getValue(), actual.get(e.getKey()));
        }
        // The two listing pages name the served report and no sourceless one.
        for (String listing : List.of(INDEX_PAGE, AGENT_PAGE)) {
            assertFalse(listing + " listed a report before any was declared", expected.get(listing).contains("StoreTotals"));
            assertTrue(listing + " lists the served report", actual.get(listing).contains("StoreTotals"));
        }
        for (String page : actual.values()) {
            for (String sourceless : SOURCELESS_REPORTS) {
                assertFalse("a sourceless report is documented: " + sourceless, page.contains(sourceless));
            }
        }
    }
}
