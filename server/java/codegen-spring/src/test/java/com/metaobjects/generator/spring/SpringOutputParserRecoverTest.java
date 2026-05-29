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

import static org.junit.Assert.assertTrue;

/**
 * Verifies that {@link SpringOutputParserGenerator} emits a typed {@code recover(...)}
 * method alongside the existing strict {@code parse(...)} method for {@code template.output}
 * declarations with {@code @format: json} or {@code @format: xml} (FR-010 Plan 2, Task 4).
 *
 * <p>The recover block is codegen-baked: a {@code RecoverSchema} constant and two
 * {@code recover} overloads (default opts + explicit opts) are emitted into the same
 * parser class. Other formats (text, html, csv, etc.) receive only the existing
 * {@code parse(...)} method — the recover block is format-gated.
 */
public class SpringOutputParserRecoverTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void emitsRecoverAlongsideParseForJsonOutput() throws Exception {
        Path out = tmp.newFolder("gen").toPath();
        Path ws = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            ws, "recover-out", SpringTestFixtures.RECOVER_OUTPUT_FIXTURE);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);

        // AnswerOutput → capitalized "AnswerOutput" → AnswerOutputParser.java
        // package acme::ai → outPkg "acme.ai.prompts" → path acme/ai/prompts/
        Path parser = out.resolve("acme/ai/prompts/AnswerOutputParser.java");
        assertTrue("parser emitted: " + parser, Files.exists(parser));

        String src = Files.readString(parser);

        // recover import must appear
        assertTrue("expected `import com.metaobjects.render.recover.Recover;`; saw:\n" + src,
            src.contains("import com.metaobjects.render.recover.Recover;"));

        // RECOVER_SCHEMA constant
        assertTrue("expected `RecoverSchema RECOVER_SCHEMA`; saw:\n" + src,
            src.contains("RecoverSchema RECOVER_SCHEMA"));

        // zero-arg recover overload
        assertTrue("expected `RecoveryResult<AnswerOutputPayload> recover(String text)`; saw:\n" + src,
            src.contains("RecoveryResult<AnswerOutputPayload> recover(String text)"));

        // opts-bearing recover overload
        assertTrue("expected `recover(String text, com.metaobjects.render.recover.RecoverOptions opts)`; saw:\n" + src,
            src.contains("recover(String text, com.metaobjects.render.recover.RecoverOptions opts)"));

        // payload constructor invocation
        assertTrue("expected `new AnswerOutputPayload(`; saw:\n" + src,
            src.contains("new AnswerOutputPayload("));

        // strict parse must still be present (recover is additive)
        assertTrue("expected `public static AnswerOutputPayload parse(String text)`; saw:\n" + src,
            src.contains("public static AnswerOutputPayload parse(String text)"));
    }

    @Test
    public void doesNotEmitRecoverForTextFormat() throws Exception {
        String textFormatFixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "SummaryPayload", "children": [
                    { "field.string": { "name": "summary" } }
                ] } },
                { "template.output": {
                    "name": "SummaryOutput",
                    "@payloadRef": "SummaryPayload",
                    "@textRef": "ai/summary",
                    "@format": "text"
                } }
              ] }
            }
            """;
        Path out = tmp.newFolder("gen-text").toPath();
        Path ws = tmp.newFolder("ws-text").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "text-out", textFormatFixture);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = out.resolve("acme/ai/prompts/SummaryOutputParser.java");
        assertTrue("parser emitted: " + parser, Files.exists(parser));

        String src = Files.readString(parser);

        // parse must still be there
        assertTrue("expected parse method; saw:\n" + src,
            src.contains("public static SummaryOutputPayload parse(String text)"));

        // recover must NOT be emitted for text format
        assertTrue("recover must NOT be emitted for @format: text; saw:\n" + src,
            !src.contains("RecoverSchema RECOVER_SCHEMA"));
        assertTrue("recover import must NOT appear for text format; saw:\n" + src,
            !src.contains("import com.metaobjects.render.recover.Recover;"));
    }

    @Test
    public void emitsRecoverForXmlFormat() throws Exception {
        String xmlFormatFixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "XmlResponsePayload", "children": [
                    { "field.string": { "name": "message", "@required": true } }
                ] } },
                { "template.output": {
                    "name": "XmlResponseOutput",
                    "@payloadRef": "XmlResponsePayload",
                    "@textRef": "ai/xml-response",
                    "@format": "xml"
                } }
              ] }
            }
            """;
        Path out = tmp.newFolder("gen-xml").toPath();
        Path ws = tmp.newFolder("ws-xml").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "xml-out", xmlFormatFixture);

        SpringOutputParserGenerator gen = new SpringOutputParserGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path parser = out.resolve("acme/ai/prompts/XmlResponseOutputParser.java");
        assertTrue("parser emitted: " + parser, Files.exists(parser));

        String src = Files.readString(parser);

        assertTrue("expected `import com.metaobjects.render.recover.Recover;` for xml; saw:\n" + src,
            src.contains("import com.metaobjects.render.recover.Recover;"));
        assertTrue("expected `RecoverSchema RECOVER_SCHEMA` for xml; saw:\n" + src,
            src.contains("RecoverSchema RECOVER_SCHEMA"));
        assertTrue("expected xml recover uses Format.XML in schema; saw:\n" + src,
            src.contains("Format.XML"));
        assertTrue("expected `RecoveryResult<XmlResponseOutputPayload> recover(String text)` for xml; saw:\n" + src,
            src.contains("RecoveryResult<XmlResponseOutputPayload> recover(String text)"));
    }
}
