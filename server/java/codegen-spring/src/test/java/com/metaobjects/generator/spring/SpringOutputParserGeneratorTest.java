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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link SpringOutputParserGenerator}. Pins the per-template.output
 * parser-class contract: one Java class per template.output, named
 * {@code <TemplateShortName>Parser}, in {@code <entity-pkg>.prompts}, with a
 * static {@code parse(String) → <TemplateShortName>Payload} method backed by
 * Jackson's {@code ObjectMapper}. FR-006 / ADR-0010 (Java throw-only matches
 * Jackson convention).
 */
public class SpringOutputParserGeneratorTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String SIMPLE_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "NpcResponsePayload", "children": [
                { "field.string": { "name": "name" } },
                { "field.int":    { "name": "age" } }
            ] } },
            { "template.prompt": {
                "name": "NpcResponseOutput",
                "@payloadRef": "NpcResponsePayload",
                "@responseRef": "NpcResponsePayload",
                "@textRef": "npc/output",
                "@format": "text",
                "@responseFormat": "json"
            } }
          ] }
        }
        """;

    @Test
    public void emitsParserClassPerOutputTemplate() throws Exception {
        Path outDir = tempFolder.newFolder("parser-simple").toPath();
        Path workspace = tempFolder.newFolder("parser-simple-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "parser-simple", SIMPLE_FIXTURE);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = outDir.resolve("acme/ai/prompts/NpcResponseOutputParser.java");
        assertTrue("expected NpcResponseOutputParser.java at " + parser, Files.exists(parser));
        String src = Files.readString(parser);

        assertTrue("expected `package acme.ai.prompts;`; saw:\n" + src,
            src.contains("package acme.ai.prompts;"));
        assertTrue("expected ObjectMapper import; saw:\n" + src,
            src.contains("import com.fasterxml.jackson.databind.ObjectMapper;"));
        assertTrue("expected JsonProcessingException import; saw:\n" + src,
            src.contains("import com.fasterxml.jackson.core.JsonProcessingException;"));
        assertTrue("expected `public final class NpcResponseOutputParser`; saw:\n" + src,
            src.contains("public final class NpcResponseOutputParser"));
        assertTrue("expected private constructor (no-instance utility); saw:\n" + src,
            src.contains("private NpcResponseOutputParser() {"));
        assertTrue("expected static MAPPER field; saw:\n" + src,
            src.contains("private static final ObjectMapper MAPPER = new ObjectMapper();"));
        assertTrue("expected `public static NpcResponseOutputResponse parse(String text)`; saw:\n" + src,
            src.contains("public static NpcResponseOutputResponse parse(String text)"));
        assertTrue("expected `throws JsonProcessingException`; saw:\n" + src,
            src.contains("throws JsonProcessingException"));
        assertTrue("expected `MAPPER.readValue(text, NpcResponseOutputResponse.class)`; saw:\n" + src,
            src.contains("MAPPER.readValue(text, NpcResponseOutputResponse.class)"));
    }

    @Test
    public void parserIsThrowOnlyNoSafeParseVariant() throws Exception {
        // ADR-0010 §3 — Java is throw-only (matches Jackson convention). A
        // TryParse-style variant on parse() would diverge from idiomatic Java/Spring.
        // Note: extractLenient() is intentionally present for json/xml and returns ExtractionResult<T>
        // — that is not a safe-parse variant; it is a separate best-effort extraction path (FR-010).
        Path outDir = tempFolder.newFolder("parser-throw-only").toPath();
        Path workspace = tempFolder.newFolder("parser-throw-only-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "parser-throw-only", SIMPLE_FIXTURE);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/ai/prompts/NpcResponseOutputParser.java"));
        assertFalse("Java is throw-only — no TryParse / safeParse variant expected; saw:\n" + src,
            src.contains("tryParse"));
        assertFalse("no Optional<T> return on parse() expected; saw:\n" + src,
            src.contains("Optional<"));
        // parse() must not return a Result-style wrapper — check signature directly.
        // extractLenient() returns ExtractionResult<T> (intentional FR-010); that is distinct from
        // wrapping parse() in a Result return type, so we assert the parse signature is bare.
        assertTrue("parse() must be a direct (throw-only) return, not Result-wrapped; saw:\n" + src,
            src.contains("public static NpcResponseOutputResponse parse(String text) throws JsonProcessingException"));
    }

    @Test
    public void skipsPromptsThatDeclareNoResponse() throws Exception {
        // ADR-0052 moved the parser ONTO template.prompt, but not onto every prompt: with
        // no @responseRef nothing elicits a typed reply, so there is nothing to parse.
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
        Path outDir = tempFolder.newFolder("parser-prompt-only").toPath();
        Path workspace = tempFolder.newFolder("parser-prompt-only-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "parser-prompt-only", fixture);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("a prompt with no @responseRef must NOT trigger parser emission",
                    0L, stream.count());
            }
        }
    }

    @Test
    public void aTemplateOutputGetsNoParser() throws Exception {
        // The ADR-0052 direction pin. The parser tier previously had NO format filter at
        // all here, so a markdown document template got a generated Jackson readValue — a
        // method that could never work — for text the system had just rendered itself.
        // @format: json is deliberate: it is the case that most looked like it belonged.
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
        Path outDir = tempFolder.newFolder("parser-outbound").toPath();
        Path workspace = tempFolder.newFolder("parser-outbound-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "parser-outbound", fixture);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("template.output must NOT trigger parser emission", 0L, stream.count());
            }
        }
    }
}
