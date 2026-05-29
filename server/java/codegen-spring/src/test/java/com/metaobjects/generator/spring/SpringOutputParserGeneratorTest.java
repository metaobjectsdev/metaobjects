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
            { "template.output": {
                "name": "NpcResponseOutput",
                "@payloadRef": "NpcResponsePayload",
                "@textRef": "npc/output",
                "@format": "json"
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
        assertTrue("expected `public static NpcResponseOutputPayload parse(String text)`; saw:\n" + src,
            src.contains("public static NpcResponseOutputPayload parse(String text)"));
        assertTrue("expected `throws JsonProcessingException`; saw:\n" + src,
            src.contains("throws JsonProcessingException"));
        assertTrue("expected `MAPPER.readValue(text, NpcResponseOutputPayload.class)`; saw:\n" + src,
            src.contains("MAPPER.readValue(text, NpcResponseOutputPayload.class)"));
    }

    @Test
    public void parserIsThrowOnlyNoSafeParseVariant() throws Exception {
        // ADR-0010 §3 — Java is throw-only (matches Jackson convention). A
        // TryParse-style variant on parse() would diverge from idiomatic Java/Spring.
        // Note: recover() is intentionally present for json/xml and returns RecoveryResult<T>
        // — that is not a safe-parse variant; it is a separate best-effort recovery path (FR-010).
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
        // recover() returns RecoveryResult<T> (intentional FR-010); that is distinct from
        // wrapping parse() in a Result return type, so we assert the parse signature is bare.
        assertTrue("parse() must be a direct (throw-only) return, not Result-wrapped; saw:\n" + src,
            src.contains("public static NpcResponseOutputPayload parse(String text) throws JsonProcessingException"));
    }

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
                assertEquals("template.prompt must NOT trigger parser emission", 0L, stream.count());
            }
        }
    }
}
