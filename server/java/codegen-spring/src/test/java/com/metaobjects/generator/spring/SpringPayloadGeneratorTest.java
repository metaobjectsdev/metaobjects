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
 * Tests for {@link SpringPayloadGenerator}. Pins the per-template.output
 * payload-record contract: one Java record per template.output, named
 * {@code <TemplateShortName>Payload}, in {@code <entity-pkg>.prompts},
 * with components mirroring the {@code @payloadRef} value-object's scalar
 * fields. FR-006 / ADR-0010.
 */
public class SpringPayloadGeneratorTest extends SharedRegistryTestBase {

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
    public void emitsRecordPerOutputTemplate() throws Exception {
        Path outDir = tempFolder.newFolder("payload-simple").toPath();
        Path workspace = tempFolder.newFolder("payload-simple-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-simple", SIMPLE_FIXTURE);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path payload = outDir.resolve("acme/ai/prompts/NpcResponseOutputPayload.java");
        assertTrue("expected NpcResponseOutputPayload.java at " + payload, Files.exists(payload));
        String src = Files.readString(payload);

        assertTrue("expected `package acme.ai.prompts;`; saw:\n" + src,
            src.contains("package acme.ai.prompts;"));
        assertTrue("expected record declaration; saw:\n" + src,
            src.contains("public record NpcResponseOutputPayload("));
        assertTrue("expected `) {}` empty body; saw:\n" + src,
            src.contains(") {}"));
        assertTrue("expected `String name` component; saw:\n" + src,
            src.contains("String name"));
        assertTrue("expected `Integer age` component (wrapped); saw:\n" + src,
            src.contains("Integer age"));
        assertFalse("expected wrapped `Integer`, not primitive `int`; saw:\n" + src,
            src.contains(" int "));
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
        Path outDir = tempFolder.newFolder("payload-prompt-only").toPath();
        Path workspace = tempFolder.newFolder("payload-prompt-only-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-prompt-only", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // Prompt-only fixture must produce zero payload files in the prompts dir.
        Path promptsDir = outDir.resolve("acme/ai/prompts");
        if (Files.exists(promptsDir)) {
            try (java.util.stream.Stream<Path> stream = Files.list(promptsDir)) {
                assertEquals("template.prompt must NOT trigger payload emission", 0L, stream.count());
            }
        }
    }

    @Test
    public void skipsTemplatesWithUnresolvedPayloadRef() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "NpcResponsePayload", "children": [
                    { "field.string": { "name": "name" } }
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
        // Happy path — emits one file. Negative payloadRef coverage lives in the
        // loader validation pass (ERR_UNRESOLVED_PAYLOAD_REF), so a missing-ref
        // fixture would fail to load, not produce a no-op generator run.
        Path outDir = tempFolder.newFolder("payload-resolved").toPath();
        Path workspace = tempFolder.newFolder("payload-resolved-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "payload-resolved", fixture);

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/NpcResponseOutputPayload.java")));
    }
}
