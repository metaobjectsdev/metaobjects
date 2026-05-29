package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * String-assert tests for {@link SpringOutputPromptGenerator}.
 *
 * <p>Pins the per-{@code template.output} prompt-class contract: one Java class per
 * {@code template.output}, named {@code <TemplateShortName>Prompt}, in
 * {@code <entity-pkg>.prompts}, with a static {@code SPEC} field and both
 * {@code renderFormat()} overloads. FR-010 Plan 3, Task 7.
 */
public class SpringOutputPromptGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    // -------------------------------------------------------------------------
    // Core emission test — uses PROMPT_VO_FIXTURE (xml + guide)
    // -------------------------------------------------------------------------

    @Test
    public void emitsPromptClassForAnswerOutputTemplate() throws Exception {
        Path outDir    = tempFolder.newFolder("prompt-emit").toPath();
        Path workspace = tempFolder.newFolder("prompt-emit-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                workspace, "prompt-emit", SpringTestFixtures.PROMPT_VO_FIXTURE);

        SpringOutputPromptGenerator gen = new SpringOutputPromptGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // Fixture: package acme::ai, template.output name "AnswerOutput"
        // → class AnswerOutputPrompt in acme/ai/prompts/
        Path promptFile = outDir.resolve("acme/ai/prompts/AnswerOutputPrompt.java");
        assertTrue("expected AnswerOutputPrompt.java at " + promptFile, Files.exists(promptFile));
        String src = Files.readString(promptFile);

        assertTrue("expected `package acme.ai.prompts;`; saw:\n" + src,
            src.contains("package acme.ai.prompts;"));
        assertTrue("expected `public final class AnswerOutputPrompt`; saw:\n" + src,
            src.contains("public final class AnswerOutputPrompt"));
        assertTrue("expected private constructor; saw:\n" + src,
            src.contains("private AnswerOutputPrompt() {"));

        // SPEC field
        assertTrue("expected OutputFormatSpec SPEC field; saw:\n" + src,
            src.contains("OutputFormatSpec SPEC"));

        // Both renderFormat() overloads
        assertTrue("expected `public static String renderFormat()` (no-arg overload); saw:\n" + src,
            src.contains("public static String renderFormat()"));
        assertTrue("expected `public static String renderFormat(PromptOverrides overrides)`; saw:\n" + src,
            src.contains("public static String renderFormat(PromptOverrides overrides)"));

        // Delegates to OutputFormatRenderer
        assertTrue("expected `OutputFormatRenderer.render(`; saw:\n" + src,
            src.contains("OutputFormatRenderer.render("));

        // Fixture uses @promptStyle: guide → SPEC must contain PromptStyle.GUIDE
        assertTrue("expected `PromptStyle.GUIDE` in SPEC literal; saw:\n" + src,
            src.contains("PromptStyle.GUIDE"));

        // Fixture uses @format: xml → SPEC must contain Format.XML
        assertTrue("expected `Format.XML` in SPEC literal; saw:\n" + src,
            src.contains("Format.XML"));

        // SPEC rootName should be the payload class name: AnswerOutputPayload
        assertTrue("expected `AnswerOutputPayload` as SPEC rootName; saw:\n" + src,
            src.contains("\"AnswerOutputPayload\""));
    }

    // -------------------------------------------------------------------------
    // Format gate: only json/xml emit a class
    // -------------------------------------------------------------------------

    @Test
    public void skipsUnsupportedFormatTemplates() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "FooPayload", "children": [
                    { "field.string": { "name": "text" } }
                ] } },
                { "template.output": {
                    "name": "FooOutput",
                    "@payloadRef": "FooPayload",
                    "@textRef": "ai/foo",
                    "@format": "text"
                } }
              ] }
            }
            """;
        Path outDir    = tempFolder.newFolder("prompt-plain").toPath();
        Path workspace = tempFolder.newFolder("prompt-plain-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "prompt-plain", fixture);

        SpringOutputPromptGenerator gen = new SpringOutputPromptGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("@format=plain must NOT trigger prompt emission", 0L, stream.count());
            }
        }
    }

    // -------------------------------------------------------------------------
    // template.prompt nodes are ignored
    // -------------------------------------------------------------------------

    @Test
    public void skipsPromptTemplates() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "NpcPromptPayload", "children": [
                    { "field.string": { "name": "mood" } }
                ] } },
                { "template.prompt": {
                    "name": "npcTurn",
                    "@payloadRef": "NpcPromptPayload",
                    "@textRef": "npc/turn",
                    "@format": "xml"
                } }
              ] }
            }
            """;
        Path outDir    = tempFolder.newFolder("prompt-skip-prompt").toPath();
        Path workspace = tempFolder.newFolder("prompt-skip-prompt-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "prompt-skip-prompt", fixture);

        SpringOutputPromptGenerator gen = new SpringOutputPromptGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("template.prompt must NOT trigger prompt emission", 0L, stream.count());
            }
        }
    }

    // -------------------------------------------------------------------------
    // Inline-style fixture also emits correctly
    // -------------------------------------------------------------------------

    @Test
    public void emitsPromptClassForJsonInlineTemplate() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "SummaryPayload", "children": [
                    { "field.string": { "name": "headline", "@required": true } },
                    { "field.string": { "name": "body" } }
                ] } },
                { "template.output": {
                    "name": "SummaryOutput",
                    "@payloadRef": "SummaryPayload",
                    "@textRef": "ai/summary",
                    "@format": "json",
                    "@promptStyle": "inline"
                } }
              ] }
            }
            """;
        Path outDir    = tempFolder.newFolder("prompt-inline").toPath();
        Path workspace = tempFolder.newFolder("prompt-inline-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "prompt-inline", fixture);

        SpringOutputPromptGenerator gen = new SpringOutputPromptGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptFile = outDir.resolve("acme/ai/prompts/SummaryOutputPrompt.java");
        assertTrue("expected SummaryOutputPrompt.java", Files.exists(promptFile));
        String src = Files.readString(promptFile);

        assertTrue("expected `PromptStyle.INLINE` in SPEC; saw:\n" + src,
            src.contains("PromptStyle.INLINE"));
        assertTrue("expected `Format.JSON` in SPEC; saw:\n" + src,
            src.contains("Format.JSON"));
    }
}
