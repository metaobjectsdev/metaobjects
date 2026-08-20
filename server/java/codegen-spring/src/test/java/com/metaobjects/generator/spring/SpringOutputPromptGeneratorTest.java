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
        // → class AnswerOutputResponseFormat in acme/ai/prompts/
        Path promptFile = outDir.resolve("acme/ai/prompts/AnswerOutputResponseFormat.java");
        assertTrue("expected AnswerOutputResponseFormat.java at " + promptFile, Files.exists(promptFile));
        String src = Files.readString(promptFile);

        assertTrue("expected `package acme.ai.prompts;`; saw:\n" + src,
            src.contains("package acme.ai.prompts;"));
        assertTrue("expected `public final class AnswerOutputResponseFormat`; saw:\n" + src,
            src.contains("public final class AnswerOutputResponseFormat"));
        assertTrue("expected private constructor; saw:\n" + src,
            src.contains("private AnswerOutputResponseFormat() {"));

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

        // Fixture uses @responseFormat: xml → SPEC must contain Format.XML. ADR-0053: its
        // @format is "text" (the prompt BODY's syntax), so a generator still reading @format
        // would emit Format.JSON here.
        assertTrue("expected `Format.XML` in SPEC literal; saw:\n" + src,
            src.contains("Format.XML"));

        // SPEC rootName is the RESPONSE record — the shape the fragment describes and the
        // parser returns — never the @payloadRef request record.
        assertTrue("expected `AnswerOutputResponse` as SPEC rootName; saw:\n" + src,
            src.contains("\"AnswerOutputResponse\""));
    }

    // -------------------------------------------------------------------------
    // ADR-0052/0053 — the gate is @responseRef presence, never a format value
    // -------------------------------------------------------------------------

    @Test
    public void aTextBodiedPromptWithAResponseStillGetsAFragment() throws Exception {
        // The case the OLD gate got wrong, and the reason D2 exists. @format is the syntax
        // of the rendered prompt BODY; a prompt written in prose that asks for a JSON reply
        // is the common shape, and it used to fall through the `@format ∈ {json,xml}` gate
        // and get NO fragment at all — the tier silently unserved for its main use case.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "FooPayload", "children": [
                    { "field.string": { "name": "text" } }
                ] } },
                { "template.prompt": {
                    "name": "FooOutput",
                    "@payloadRef": "FooPayload",
                    "@responseRef": "FooPayload",
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

        Path promptFile = outDir.resolve("acme/ai/prompts/FooOutputResponseFormat.java");
        assertTrue("a text-bodied prompt declaring @responseRef must still get a fragment at "
            + promptFile, Files.exists(promptFile));
        // @responseFormat is absent, so it defaults to json (ADR-0053) — NOT to @format's "text".
        assertTrue("absent @responseFormat must default to Format.JSON",
            Files.readString(promptFile).contains("Format.JSON"));
    }

    @Test
    public void aTemplateOutputGetsNoFragmentWhateverItsFormat() throws Exception {
        // The ADR-0052 direction pin. template.output is OUTBOUND ONLY: it renders a
        // document or an email, and nothing about it instructs a model how to reply.
        // @format: json here is deliberate — under the old rule this was the case that
        // DID emit, so a fragment appearing would prove the direction rule is not applied.
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "DocPayload", "children": [
                    { "field.string": { "name": "body" } }
                ] } },
                { "template.output": {
                    "name": "WelcomeDoc",
                    "@payloadRef": "DocPayload",
                    "@textRef": "mail/welcome",
                    "@format": "json"
                } }
              ] }
            }
            """;
        Path outDir    = tempFolder.newFolder("prompt-outbound").toPath();
        Path workspace = tempFolder.newFolder("prompt-outbound-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "prompt-outbound", fixture);

        SpringOutputPromptGenerator gen = new SpringOutputPromptGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("template.output must NOT trigger fragment emission", 0L, stream.count());
            }
        }
    }

    // -------------------------------------------------------------------------
    // A prompt that declares NO response is not inbound
    // -------------------------------------------------------------------------

    @Test
    public void skipsPromptsThatDeclareNoResponse() throws Exception {
        // ADR-0052 moved the inbound tier ONTO template.prompt, but not onto every prompt:
        // a prompt with no @responseRef elicits no typed reply, so there is nothing to
        // instruct the model about and nothing to parse. This is the half of the direction
        // rule that keeps "prompt" from meaning "always inbound".
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
                assertEquals("a prompt with no @responseRef must NOT trigger fragment emission",
                    0L, stream.count());
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
                { "template.prompt": {
                    "name": "SummaryOutput",
                    "@payloadRef": "SummaryPayload",
                    "@responseRef": "SummaryPayload",
                    "@textRef": "ai/summary",
                    "@format": "text",
                    "@responseFormat": "json",
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

        Path promptFile = outDir.resolve("acme/ai/prompts/SummaryOutputResponseFormat.java");
        assertTrue("expected SummaryOutputResponseFormat.java", Files.exists(promptFile));
        String src = Files.readString(promptFile);

        assertTrue("expected `PromptStyle.INLINE` in SPEC; saw:\n" + src,
            src.contains("PromptStyle.INLINE"));
        assertTrue("expected `Format.JSON` in SPEC; saw:\n" + src,
            src.contains("Format.JSON"));
    }
}
