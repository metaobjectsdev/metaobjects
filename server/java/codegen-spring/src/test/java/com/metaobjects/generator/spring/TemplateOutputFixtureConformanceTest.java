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
 * Conformance test for the FR-010 inbound codegen contract, loading the cross-port
 * fixtures from {@code fixtures/conformance/template-prompt-response-{json,xml}/input/meta.json}.
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
        // ADR-0052 renamed these: the inbound tier is driven by a responding
        // template.prompt, so the fixtures are template-prompt-response-{json,xml}.
        // Both carry `@format: "text"` with a `@responseFormat` that differs from it —
        // the case that discriminates ADR-0053's two-attribute split. A generator still
        // reading @format would emit Format.JSON for BOTH rows and fail the xml one.
        return List.of(
            new Object[]{ "template-prompt-response-json", "PromptStyle.INLINE", "Format.JSON", true  },
            new Object[]{ "template-prompt-response-xml",  "PromptStyle.GUIDE",  "Format.XML",  false }
        );
    }

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final String fixtureName;
    private final String promptStyleConstant;
    private final String formatConstant;
    private final boolean expectStrictTier;

    public TemplateOutputFixtureConformanceTest(
            String fixtureName, String promptStyleConstant, String formatConstant,
            boolean expectStrictTier) {
        this.fixtureName = fixtureName;
        this.promptStyleConstant = promptStyleConstant;
        this.formatConstant = formatConstant;
        this.expectStrictTier = expectStrictTier;
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

        // ---- Fixtures: package acme::support, template.prompt name "SupportAnswerPrompt"
        // outPkg = acme.support.prompts → path acme/support/prompts/
        Path promptFile = outDir.resolve("acme/support/prompts/SupportAnswerPromptResponseFormat.java");
        Path parserFile = outDir.resolve("acme/support/prompts/SupportAnswerPromptParser.java");

        // ---- Prompt assertions ----

        assertTrue("[" + fixtureName + "] expected SupportAnswerPromptResponseFormat.java at "
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

        assertTrue("[" + fixtureName + "] expected SupportAnswerPromptParser.java at "
                + parserFile, Files.exists(parserFile));
        String parserSrc = Files.readString(parserFile);

        // The tolerant tier is emitted for EVERY responding prompt — declaring a response
        // shape is the request for one, and it is the only tier an XML reply gets.
        assertTrue("[" + fixtureName + "] expected loader-delegating `extractLenient(com.metaobjects.loader.MetaDataLoader`; saw:\n" + parserSrc,
            parserSrc.contains("extractLenient(com.metaobjects.loader.MetaDataLoader"));

        // ADR-0053: the strict Jackson tier is JSON-ONLY. Strict all-or-nothing semantics
        // layered over the REPAIRING XML reader would throw or accept based on how much
        // repair happened, which is not a contract anyone can reason about.
        if (expectStrictTier) {
            assertTrue("[" + fixtureName + "] expected the strict `parse(` tier; saw:\n" + parserSrc,
                parserSrc.contains("public static SupportAnswerPromptResponse parse(String text)"));
        } else {
            assertTrue("[" + fixtureName + "] XML reply must get NO strict parse tier; saw:\n" + parserSrc,
                !parserSrc.contains("public static SupportAnswerPromptResponse parse(String text)"));
            assertTrue("[" + fixtureName + "] XML reply must not import Jackson; saw:\n" + parserSrc,
                !parserSrc.contains("com.fasterxml.jackson"));
        }

        // ADR-0052: the parser returns the @responseRef shape (SupportAnswer), never the
        // @payloadRef request shape (SupportRequest) — the distinction the ADR exists to draw.
        assertTrue("[" + fixtureName + "] parser must not bind the request shape; saw:\n" + parserSrc,
            !parserSrc.contains("SupportRequest"));

        // No baked snapshot must survive (Move 1: the FieldSpec-literal path is gone).
        assertTrue("[" + fixtureName + "] must NOT emit a baked `ExtractSchema EXTRACT_SCHEMA` literal; saw:\n" + parserSrc,
            !parserSrc.contains("EXTRACT_SCHEMA"));
    }
}
