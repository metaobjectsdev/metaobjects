package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertTrue;

/**
 * Conformance test for the FR-010 output codegen contract, loading the cross-port
 * fixtures from {@code fixtures/conformance/template-output-{json,xml}-simple/input/meta.json}.
 *
 * <p>Asserts the key structural markers emitted by both
 * {@link SpringOutputPromptGenerator} and {@link SpringOutputParserGenerator} for each
 * fixture. Behavioral correctness is proven by the compile-run tests
 * ({@code GeneratedOutputPromptCompileRunTest}, {@code GeneratedNestedExtractLenientCompileRunTest}).
 *
 * <p>Repo root is located by walking up from {@code user.dir} until the
 * {@code fixtures/conformance} directory is found — the same strategy used by
 * {@code ExtractConformanceTest} in the render module.
 */
@RunWith(Parameterized.class)
public class TemplateOutputFixtureConformanceTest extends SharedRegistryTestBase {

    // -------------------------------------------------------------------------
    // Locate repo root once at class-load time.
    // -------------------------------------------------------------------------

    private static final Path CONFORMANCE_ROOT;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/conformance"))) {
            p = p.getParent();
        }
        CONFORMANCE_ROOT = (p != null) ? p.resolve("fixtures/conformance") : null;
    }

    // -------------------------------------------------------------------------
    // Parameterized cases: (fixtureName, promptStyleConstant, formatConstant)
    // -------------------------------------------------------------------------

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> cases() {
        return List.of(
            new Object[]{ "template-output-json-simple", "PromptStyle.INLINE", "Format.JSON" },
            new Object[]{ "template-output-xml-simple",  "PromptStyle.GUIDE",  "Format.XML"  }
        );
    }

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final String fixtureName;
    private final String promptStyleConstant;
    private final String formatConstant;

    public TemplateOutputFixtureConformanceTest(
            String fixtureName, String promptStyleConstant, String formatConstant) {
        this.fixtureName = fixtureName;
        this.promptStyleConstant = promptStyleConstant;
        this.formatConstant = formatConstant;
    }

    // -------------------------------------------------------------------------
    // Test
    // -------------------------------------------------------------------------

    @Test
    public void bothGeneratorsEmitExpectedStructuralMarkers() throws Exception {
        assertTrue("fixtures/conformance directory must be reachable; check user.dir = "
                + System.getProperty("user.dir"), CONFORMANCE_ROOT != null);

        Path fixtureInput = CONFORMANCE_ROOT.resolve(fixtureName).resolve("input").resolve("meta.json");
        assertTrue("fixture input must exist: " + fixtureInput, Files.exists(fixtureInput));

        // Load the fixture file via a temp workspace (mirrors SpringTestFixtures.loadFixture).
        String fixtureJson = Files.readString(fixtureInput);
        Path workspace = tmp.newFolder("ws-" + fixtureName).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, fixtureName, fixtureJson);

        Path outDir = tmp.newFolder("out-" + fixtureName).toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());

        // Run SpringOutputPromptGenerator.
        SpringOutputPromptGenerator promptGen = new SpringOutputPromptGenerator();
        promptGen.setArgs(args);
        promptGen.execute(loader);

        // Run SpringOutputParserGenerator.
        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        // ---- Fixtures: package acme::support, template.output name "SupportAnswerOutput"
        // outPkg = acme.support.prompts → path acme/support/prompts/
        Path promptFile = outDir.resolve("acme/support/prompts/SupportAnswerOutputPrompt.java");
        Path parserFile = outDir.resolve("acme/support/prompts/SupportAnswerOutputParser.java");

        // ---- Prompt assertions ----

        assertTrue("[" + fixtureName + "] expected SupportAnswerOutputPrompt.java at "
                + promptFile, Files.exists(promptFile));
        String promptSrc = Files.readString(promptFile);

        assertTrue("[" + fixtureName + "] expected `OutputFormatRenderer.render(`; saw:\n" + promptSrc,
            promptSrc.contains("OutputFormatRenderer.render("));

        assertTrue("[" + fixtureName + "] expected `public static String renderFormat()` (no-arg overload); saw:\n" + promptSrc,
            promptSrc.contains("public static String renderFormat()"));

        assertTrue("[" + fixtureName + "] expected `public static String renderFormat(PromptOverrides overrides)`; saw:\n" + promptSrc,
            promptSrc.contains("public static String renderFormat(PromptOverrides overrides)"));

        assertTrue("[" + fixtureName + "] expected `" + promptStyleConstant + "` in prompt source; saw:\n" + promptSrc,
            promptSrc.contains(promptStyleConstant));

        assertTrue("[" + fixtureName + "] expected `" + formatConstant + "` in prompt source; saw:\n" + promptSrc,
            promptSrc.contains(formatConstant));

        // ---- Parser assertions ----

        assertTrue("[" + fixtureName + "] expected SupportAnswerOutputParser.java at "
                + parserFile, Files.exists(parserFile));
        String parserSrc = Files.readString(parserFile);

        // The single metadata-driven extract path: a loader-delegating extractLenient(...)
        // overload alongside the strict parse(...). No baked ExtractSchema literal anymore.
        assertTrue("[" + fixtureName + "] expected loader-delegating `extractLenient(com.metaobjects.loader.MetaDataLoader`; saw:\n" + parserSrc,
            parserSrc.contains("extractLenient(com.metaobjects.loader.MetaDataLoader"));

        assertTrue("[" + fixtureName + "] expected `parse(`; saw:\n" + parserSrc,
            parserSrc.contains("parse("));

        // No baked snapshot must survive (Move 1: the FieldSpec-literal path is gone).
        assertTrue("[" + fixtureName + "] must NOT emit a baked `ExtractSchema EXTRACT_SCHEMA` literal; saw:\n" + parserSrc,
            !parserSrc.contains("EXTRACT_SCHEMA"));
    }
}
