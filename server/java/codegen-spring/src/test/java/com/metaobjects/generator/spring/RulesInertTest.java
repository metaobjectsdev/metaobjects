package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorRegistry;
import com.metaobjects.generator.GeneratorRegistry.GeneratorInfo;
import com.metaobjects.generator.apidocs.ApiUnit;
import com.metaobjects.generator.apidocs.DocsPaths;
import com.metaobjects.generator.apidocs.JavaApiDocsRenderer;
import com.metaobjects.generator.apidocs.JavaApiModel;
import com.metaobjects.generator.apidocs.JavaApiModelBuilder;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.MetaDataLoader;
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
 * ADR-0063 - the business-rules vocabulary is INERT in the Java generators.
 *
 * <p>{@code api.operational}, {@code operation.*}, {@code binding.rest} and
 * {@code transition.action} are registered, validated at load and checked in {@code verify}, and
 * nothing generates from them yet: a model that uses them emits exactly what the same model
 * without them emits, byte for byte, through every generator in {@link GeneratorRegistry} and
 * every page of the api reference.
 *
 * <p>The model pair is {@code fixtures/codegen-noop/rules/{with,without}}, shared with the
 * other ports' copies of this test.
 */
public class RulesInertTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String THREW = "<threw>";

    private static Path model(String variant) {
        return SpringTestFixtures.findCorpusRoot().getParent()
            .resolve("codegen-noop/rules/" + variant + "/meta.purchasing.json");
    }

    private MetaDataLoader load(String variant) throws Exception {
        String json = Files.readString(model(variant), StandardCharsets.UTF_8);
        // One loader name for both variants: the model tier stamps it into generated code.
        return SpringTestFixtures.loadFixture(tempFolder.newFolder().toPath(), "purchasing", json);
    }

    private static Generator instantiate(GeneratorInfo info) throws Exception {
        return (Generator) Class.forName(info.classname()).getDeclaredConstructor().newInstance();
    }

    /** Run a generator suite into a fresh directory; a throw is the single entry {@code <threw>}. */
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
                if ("entity".equals(info.stableName())) {
                    args.put("type", "class");
                    args.put("flavor", "pojoAware");
                }
                if (!(gen instanceof MultiFileDirectGeneratorBase)) {
                    args.put("outputFilename", gen.getClass().getSimpleName() + ".out");
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
                files.put(outDir.relativize(p).toString(), Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return files;
    }

    private static void assertSame(String label, Map<String, String> expected, Map<String, String> actual) {
        assertEquals(label + ": emitted file set", new ArrayList<>(expected.keySet()), new ArrayList<>(actual.keySet()));
        for (Map.Entry<String, String> e : expected.entrySet()) {
            assertEquals(label + ": " + e.getKey() + " differs once rules nodes are declared",
                e.getValue(), actual.get(e.getKey()));
        }
    }

    @Test
    public void theWithModelReallyCarriesTheVocabulary() throws Exception {
        // Else every comparison below is vacuously green.
        MetaRoot with = load("with").getRoot();
        int apis = 0;
        int transitions = 0;
        for (MetaData child : with.getChildren(MetaData.class, true)) {
            if ("api".equals(child.getType())) apis++;
            if ("object".equals(child.getType())) {
                for (MetaData f : child.getChildren(MetaData.class, true)) {
                    for (MetaData t : f.getChildren(MetaData.class, true)) {
                        if ("transition".equals(t.getType())) transitions++;
                    }
                }
            }
        }
        assertEquals("api nodes", 1, apis);
        assertEquals("transitions", 3, transitions);
        for (MetaData child : load("without").getRoot().getChildren(MetaData.class, true)) {
            assertFalse("without-model declares an api", "api".equals(child.getType()));
        }
    }

    @Test
    public void everyGeneratorEmitsTheSameFiles() throws Exception {
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
        Map<String, GeneratorInfo> all = GeneratorRegistry.list();
        for (List<String> tier : List.of(
                List.of("entity", "names"),
                List.of("value-object", "dto", "repository", "filter-allowlist", "routes", "names"))) {
            List<GeneratorInfo> suite = tier.stream().map(all::get).collect(Collectors.toList());
            Map<String, String> expected = emit("without", suite);
            assertFalse(tier + " threw: " + expected.get(THREW), expected.containsKey(THREW));
            assertTrue(tier + ": only " + expected.size() + " files - the suite barely ran", expected.size() >= 3);
            assertSame(tier.toString(), expected, emit("with", suite));
        }
    }

    /** The api docs surface: every unit page, the index and the agent page. */
    private Map<String, String> apiDocs(String variant) throws Exception {
        JavaApiModel model = new JavaApiModelBuilder().build(load(variant), "purchasing");
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
    public void theApiReferenceIsIdentical() throws Exception {
        Map<String, String> expected = apiDocs("without");
        assertTrue("only " + expected.size() + " pages - the docs barely ran", expected.size() >= 3);
        assertSame("api docs", expected, apiDocs("with"));
    }
}
