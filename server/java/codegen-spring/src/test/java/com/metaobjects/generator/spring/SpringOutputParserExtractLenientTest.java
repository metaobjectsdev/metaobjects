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
 * Verifies that {@link SpringOutputParserGenerator} emits a typed {@code extractLenient(...)}
 * method alongside the existing strict {@code parse(...)} method for {@code template.output}
 * declarations with {@code @format: json} or {@code @format: xml} (FR-010 Plan 2, Task 4).
 *
 * <p>The extract block is codegen-baked: a {@code ExtractSchema} constant and two
 * {@code extract} overloads (default opts + explicit opts) are emitted into the same
 * parser class. Other formats (text, html, csv, etc.) receive only the existing
 * {@code parse(...)} method — the extract block is format-gated.
 */
public class SpringOutputParserExtractLenientTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void emitsExtractLenientAlongsideParseForJsonOutput() throws Exception {
        Path out = tmp.newFolder("gen").toPath();
        Path ws = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            ws, "extract-out", SpringTestFixtures.EXTRACT_OUTPUT_FIXTURE);

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

        // extract import must appear
        assertTrue("expected `import com.metaobjects.render.extract.Extract;`; saw:\n" + src,
            src.contains("import com.metaobjects.render.extract.Extract;"));

        // EXTRACT_SCHEMA constant
        assertTrue("expected `ExtractSchema EXTRACT_SCHEMA`; saw:\n" + src,
            src.contains("ExtractSchema EXTRACT_SCHEMA"));

        // zero-arg extract overload
        assertTrue("expected `ExtractionResult<AnswerOutputPayload> extractLenient(String text)`; saw:\n" + src,
            src.contains("ExtractionResult<AnswerOutputPayload> extractLenient(String text)"));

        // opts-bearing extract overload
        assertTrue("expected `extractLenient(String text, com.metaobjects.render.extract.ExtractOptions opts)`; saw:\n" + src,
            src.contains("extractLenient(String text, com.metaobjects.render.extract.ExtractOptions opts)"));

        // payload constructor invocation
        assertTrue("expected `new AnswerOutputPayload(`; saw:\n" + src,
            src.contains("new AnswerOutputPayload("));

        // strict parse must still be present (extract is additive)
        assertTrue("expected `public static AnswerOutputPayload parse(String text)`; saw:\n" + src,
            src.contains("public static AnswerOutputPayload parse(String text)"));
    }

    @Test
    public void doesNotEmitExtractLenientForTextFormat() throws Exception {
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

        // extract must NOT be emitted for text format
        assertTrue("extract must NOT be emitted for @format: text; saw:\n" + src,
            !src.contains("ExtractSchema EXTRACT_SCHEMA"));
        assertTrue("extract import must NOT appear for text format; saw:\n" + src,
            !src.contains("import com.metaobjects.render.extract.Extract;"));
    }

    @Test
    public void emitsExtractForXmlFormat() throws Exception {
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

        assertTrue("expected `import com.metaobjects.render.extract.Extract;` for xml; saw:\n" + src,
            src.contains("import com.metaobjects.render.extract.Extract;"));
        assertTrue("expected `ExtractSchema EXTRACT_SCHEMA` for xml; saw:\n" + src,
            src.contains("ExtractSchema EXTRACT_SCHEMA"));
        assertTrue("expected xml extract uses Format.XML in schema; saw:\n" + src,
            src.contains("Format.XML"));
        assertTrue("expected `ExtractionResult<XmlResponseOutputPayload> extractLenient(String text)` for xml; saw:\n" + src,
            src.contains("ExtractionResult<XmlResponseOutputPayload> extractLenient(String text)"));
    }
}
