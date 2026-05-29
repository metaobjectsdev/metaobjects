package com.metaobjects.generator.spring;

import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.template.MetaTemplate;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link OutputFormatSpecEmitter}.
 *
 * <p>Pins the {@link OutputFormatSpecEmitter#specLiteral} source-literal contract:
 * <ul>
 *   <li>{@code Format.*} from {@code @format} on the template</li>
 *   <li>{@code PromptStyle.*} from {@code @promptStyle} on the template</li>
 *   <li>{@code new PromptField(...)} per VO field, with correct {@code FieldKind},
 *       required/array flags, enum values, enumDoc map, example, instruction</li>
 *   <li>{@code @example}/{@code @instruction} values escaped for Java string literals</li>
 *   <li>Absent optional attrs emitted as {@code null}</li>
 * </ul>
 *
 * <p>The fixture ({@link SpringTestFixtures#PROMPT_VO_FIXTURE}) has three fields:
 * {@code text} (string, required, example "hello", instruction "one sentence"),
 * {@code confidence} (enum, required, values HIGH/OK/LOW, enumDoc for HIGH+OK),
 * {@code note} (string, optional).
 */
public class OutputFormatSpecEmitterTest extends SharedRegistryTestBase {

    // -------------------------------------------------------------------------
    // Fixture helpers
    // -------------------------------------------------------------------------

    private static Object[] loadBoth() throws Exception {
        return SpringTestFixtures.loadVoAndTemplate(
            SpringTestFixtures.PROMPT_VO_FIXTURE,
            "AnswerOutputPayload",
            "AnswerOutput");
    }

    private static MetaObject vo(Object[] pair) { return (MetaObject) pair[0]; }
    private static MetaTemplate tmpl(Object[] pair) { return (MetaTemplate) pair[1]; }

    // -------------------------------------------------------------------------
    // Top-level OutputFormatSpec literal
    // -------------------------------------------------------------------------

    @Test
    public void emitsOutputFormatSpecWithXmlAndGuide() throws Exception {
        Object[] pair = loadBoth();
        String s = OutputFormatSpecEmitter.specLiteral(vo(pair), tmpl(pair), "AnswerOutputPayload");

        assertTrue("expected new OutputFormatSpec(Format.XML, \"AnswerOutputPayload\", PromptStyle.GUIDE, java.util.List.of(; saw:\n" + s,
            s.contains("new OutputFormatSpec(Format.XML, \"AnswerOutputPayload\", PromptStyle.GUIDE, java.util.List.of("));
    }

    // -------------------------------------------------------------------------
    // Scalar field: text (string, required, @example, @instruction)
    // -------------------------------------------------------------------------

    @Test
    public void emitsTextFieldWithExampleAndInstruction() throws Exception {
        Object[] pair = loadBoth();
        String s = OutputFormatSpecEmitter.specLiteral(vo(pair), tmpl(pair), "AnswerOutputPayload");

        assertTrue("expected PromptField for text with FieldKind.STRING, required=true, array=false, "
            + "nulls for enum, example=\"hello\", instruction=\"one sentence\"; saw:\n" + s,
            s.contains("new PromptField(\"text\", FieldKind.STRING, true, false, null, null, \"hello\", \"one sentence\", null)"));
    }

    // -------------------------------------------------------------------------
    // Enum field: confidence (required, @values, @enumDoc)
    // -------------------------------------------------------------------------

    @Test
    public void emitsConfidenceEnumFieldWithValuesAndEnumDoc() throws Exception {
        Object[] pair = loadBoth();
        String s = OutputFormatSpecEmitter.specLiteral(vo(pair), tmpl(pair), "AnswerOutputPayload");

        assertTrue("expected FieldKind.ENUM for confidence, required=true; saw:\n" + s,
            s.contains("new PromptField(\"confidence\", FieldKind.ENUM, true, false,"));

        assertTrue("expected List.of(\"HIGH\", \"OK\", \"LOW\") for enum values; saw:\n" + s,
            s.contains("java.util.List.of(\"HIGH\", \"OK\", \"LOW\")"));

        assertTrue("expected Map.ofEntries for enumDoc; saw:\n" + s,
            s.contains("java.util.Map.ofEntries("));

        // Keys sorted alphabetically: HIGH before OK
        assertTrue("expected Map.entry(\"HIGH\", \"Directly supported.\"); saw:\n" + s,
            s.contains("java.util.Map.entry(\"HIGH\", \"Directly supported.\")"));

        assertTrue("expected Map.entry(\"OK\", \"Inference.\"); saw:\n" + s,
            s.contains("java.util.Map.entry(\"OK\", \"Inference.\")"));

        // Verify HIGH comes before OK in sorted output
        int highIdx = s.indexOf("java.util.Map.entry(\"HIGH\"");
        int okIdx   = s.indexOf("java.util.Map.entry(\"OK\"");
        assertTrue("enumDoc keys should be sorted: HIGH before OK", highIdx < okIdx);
    }

    @Test
    public void enumDocNullWhenAbsent() throws Exception {
        // The recover-VO fixture has @enumAlias but no @enumDoc — enumDoc should be null.
        MetaObject recoverVo = SpringTestFixtures.loadVo(
            SpringTestFixtures.RECOVER_VO_FIXTURE, "AnswerOutputPayload");
        // Use a minimal template with json format (we just need any template for format/style)
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(
            SpringTestFixtures.RECOVER_OUTPUT_FIXTURE, "AnswerOutput");

        String s = OutputFormatSpecEmitter.specLiteral(recoverVo, tmpl, "AnswerOutputPayload");

        // The confidence field has @enumAlias but no @enumDoc, so enumDoc arg must be null.
        // Find the confidence PromptField in the output.
        int confIdx = s.indexOf("\"confidence\"");
        assertTrue("expected confidence field; saw:\n" + s, confIdx >= 0);

        // Extract the PromptField(...) containing "confidence"
        String confPart = s.substring(confIdx);
        // The 6th argument (enumDoc position) should be null before example/instruction
        // Pattern: new PromptField("confidence", FieldKind.ENUM, ..., List.of(...), null, null, null, null)
        assertTrue("expected null enumDoc for confidence (no @enumDoc); saw:\n" + s,
            confPart.startsWith("\"confidence\", FieldKind.ENUM, true, false, java.util.List.of(")
            && confPart.contains("), null, null, null, null)"));
    }

    // -------------------------------------------------------------------------
    // Optional field: note (string, no @example, no @instruction)
    // -------------------------------------------------------------------------

    @Test
    public void emitsNoteFieldAsOptionalWithNulls() throws Exception {
        Object[] pair = loadBoth();
        String s = OutputFormatSpecEmitter.specLiteral(vo(pair), tmpl(pair), "AnswerOutputPayload");

        assertTrue("expected PromptField for note, required=false, all nullable attrs null; saw:\n" + s,
            s.contains("new PromptField(\"note\", FieldKind.STRING, false, false, null, null, null, null, null)"));
    }

    // -------------------------------------------------------------------------
    // Format mapping: JSON
    // -------------------------------------------------------------------------

    @Test
    public void jsonFormatEmitsFormatJson() throws Exception {
        // Use the RECOVER_OUTPUT_FIXTURE which has @format: "json"
        MetaObject vo = SpringTestFixtures.loadVo(
            SpringTestFixtures.RECOVER_OUTPUT_FIXTURE, "AnswerOutputPayload");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(
            SpringTestFixtures.RECOVER_OUTPUT_FIXTURE, "AnswerOutput");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload");

        assertTrue("expected Format.JSON for @format:json; saw:\n" + s,
            s.contains("Format.JSON"));
        assertFalse("must not contain Format.XML for @format:json; saw:\n" + s,
            s.contains("Format.XML"));
    }

    // -------------------------------------------------------------------------
    // PromptStyle mapping: inline + exampleOnly
    // -------------------------------------------------------------------------

    @Test
    public void inlinePromptStyleEmitsInline() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "StylePayload", "children": [
                    { "field.string": { "name": "x" } }
                ] } },
                { "template.output": {
                    "name": "StyleTemplate",
                    "@payloadRef": "StylePayload",
                    "@textRef": "style/inline",
                    "@format": "json",
                    "@promptStyle": "inline"
                } }
              ] }
            }
            """;
        MetaObject vo = SpringTestFixtures.loadVo(fixture, "StylePayload");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(fixture, "StyleTemplate");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "StylePayload");
        assertTrue("expected PromptStyle.INLINE; saw:\n" + s, s.contains("PromptStyle.INLINE"));
    }

    @Test
    public void exampleOnlyPromptStyleEmitsExampleOnly() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "StylePayload2", "children": [
                    { "field.string": { "name": "y" } }
                ] } },
                { "template.output": {
                    "name": "StyleTemplate2",
                    "@payloadRef": "StylePayload2",
                    "@textRef": "style/exampleOnly",
                    "@format": "json",
                    "@promptStyle": "exampleOnly"
                } }
              ] }
            }
            """;
        MetaObject vo = SpringTestFixtures.loadVo(fixture, "StylePayload2");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(fixture, "StyleTemplate2");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "StylePayload2");
        assertTrue("expected PromptStyle.EXAMPLE_ONLY; saw:\n" + s, s.contains("PromptStyle.EXAMPLE_ONLY"));
    }

    @Test
    public void absentPromptStyleDefaultsToGuide() throws Exception {
        // RECOVER_OUTPUT_FIXTURE has no @promptStyle — should default to GUIDE.
        MetaObject vo = SpringTestFixtures.loadVo(
            SpringTestFixtures.RECOVER_OUTPUT_FIXTURE, "AnswerOutputPayload");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(
            SpringTestFixtures.RECOVER_OUTPUT_FIXTURE, "AnswerOutput");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload");
        assertTrue("absent @promptStyle should default to PromptStyle.GUIDE; saw:\n" + s,
            s.contains("PromptStyle.GUIDE"));
    }

    // -------------------------------------------------------------------------
    // Java string escaping: @instruction containing a double-quote
    // -------------------------------------------------------------------------

    @Test
    public void instructionWithQuoteIsEscaped() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::test", "children": [
                { "object.value": { "name": "QuotePayload", "children": [
                    { "field.string": { "name": "msg", "@instruction": "say \\"hi\\"" } }
                ] } },
                { "template.output": {
                    "name": "QuoteTemplate",
                    "@payloadRef": "QuotePayload",
                    "@textRef": "test/quote",
                    "@format": "json"
                } }
              ] }
            }
            """;
        MetaObject vo = SpringTestFixtures.loadVo(fixture, "QuotePayload");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(fixture, "QuoteTemplate");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "QuotePayload");

        // The instruction value `say "hi"` must be emitted as `say \"hi\"` inside a Java literal.
        assertTrue("expected escaped double-quotes in instruction; saw:\n" + s,
            s.contains("\"say \\\"hi\\\"\""));
    }

    @Test
    public void javaStringLiteralEscapesBackslash() {
        assertEquals("a\\\\b", OutputFormatSpecEmitter.javaStringLiteral("a\\b"));
    }

    @Test
    public void javaStringLiteralEscapesQuote() {
        assertEquals("say \\\"hi\\\"", OutputFormatSpecEmitter.javaStringLiteral("say \"hi\""));
    }

    @Test
    public void javaStringLiteralEscapesNewline() {
        assertEquals("line1\\nline2", OutputFormatSpecEmitter.javaStringLiteral("line1\nline2"));
    }

    // -------------------------------------------------------------------------
    // Map.ofEntries regression — enumDoc with >10 entries must not use Map.of
    // -------------------------------------------------------------------------

    @Test
    public void bigEnumDocUsesMapOfEntriesNotMapOf() throws Exception {
        String fixture = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "BigDocPayload", "children": [
                    { "field.enum": { "name": "level", "@required": true,
                                     "@values": ["A","B"],
                                     "@enumDoc": {
                                       "k01": "v01", "k02": "v02", "k03": "v03",
                                       "k04": "v04", "k05": "v05", "k06": "v06",
                                       "k07": "v07", "k08": "v08", "k09": "v09",
                                       "k10": "v10", "k11": "v11", "k12": "v12"
                                     } } }
                ] } },
                { "template.output": {
                    "name": "BigDocTemplate",
                    "@payloadRef": "BigDocPayload",
                    "@textRef": "test/big",
                    "@format": "json"
                } }
              ] }
            }
            """;
        MetaObject vo = SpringTestFixtures.loadVo(fixture, "BigDocPayload");
        MetaTemplate tmpl = SpringTestFixtures.loadTemplate(fixture, "BigDocTemplate");

        String s = OutputFormatSpecEmitter.specLiteral(vo, tmpl, "BigDocPayload");

        assertTrue("expected Map.ofEntries for 12-entry enumDoc; saw:\n" + s,
            s.contains("java.util.Map.ofEntries("));

        // Count Map.entry occurrences — must be exactly 12
        int count = 0;
        int idx = 0;
        while ((idx = s.indexOf("java.util.Map.entry(", idx)) != -1) {
            count++;
            idx += "java.util.Map.entry(".length();
        }
        assertEquals("expected 12 Map.entry calls; saw:\n" + s, 12, count);

        assertFalse("must not use bare Map.of( for >10 enumDoc entries; saw:\n" + s,
            s.contains("java.util.Map.of(\"k"));
    }
}
