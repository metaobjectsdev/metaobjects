package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.metadata.ktx.metaObjectOrNull
import com.metaobjects.metadata.ktx.outputTemplateOrNull
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.OutputTemplate
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/**
 * Unit tests for [KotlinOutputFormatSpecEmitter] — FR-010 Kotlin port of the
 * VO+template → `OutputFormatSpec` source-string helper.
 *
 * Fixture: `object.value` `AnswerOutputPayload` (pkg `acme::ai`) with:
 * - `text`       (field.string, @required true, @example "hello", @instruction "one sentence")
 * - `confidence` (field.enum,   @required true, @values [HIGH,OK,LOW],
 *                               @enumDoc {HIGH:"Directly supported.", OK:"Inference."})
 * - `note`       (field.string, optional)
 *
 * Template: `template.output` `AnswerOutput`, @format "xml", @promptStyle "guide".
 *
 * Mirrors the Java `OutputFormatSpecEmitterTest` contract adapted for Kotlin collection
 * literals (`listOf`, `mapOf`) and Kotlin record-constructor syntax.
 */
class KotlinOutputFormatSpecEmitterTest {

    private val fixture = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string": { "name": "text",       "@required": true,
                                   "@example": "hello", "@instruction": "one sentence" } },
                { "field.enum":   { "name": "confidence", "@required": true,
                                   "@values": ["HIGH","OK","LOW"],
                                   "@enumDoc": { "HIGH": "Directly supported.", "OK": "Inference." } } },
                { "field.string": { "name": "note" } }
            ] } },
            { "template.output": {
                "name": "AnswerOutput",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "xml",
                "@promptStyle": "guide"
            } }
          ] }
        }
    """.trimIndent()

    private fun loadVoAndTemplate(): Pair<MetaObject, OutputTemplate> {
        val loader = loadString("kofs-test", fixture)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::AnswerOutputPayload")) {
            "AnswerOutputPayload not found in loader"
        }
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::AnswerOutput")) {
            "AnswerOutput not found in loader"
        }
        return vo to tmpl
    }

    // -------------------------------------------------------------------------
    // Top-level OutputFormatSpec literal
    // -------------------------------------------------------------------------

    @Test fun emitsOutputFormatSpecWithXmlAndGuide() {
        val (vo, tmpl) = loadVoAndTemplate()
        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue(
            "OutputFormatSpec(Format.XML, \"AnswerOutputPayload\", PromptStyle.GUIDE, listOf(" in s,
            "expected OutputFormatSpec header with XML + GUIDE; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // Scalar field: text (string, required, @example, @instruction)
    // -------------------------------------------------------------------------

    @Test fun emitsTextFieldWithExampleAndInstruction() {
        val (vo, tmpl) = loadVoAndTemplate()
        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue(
            "PromptField(\"text\", FieldKind.STRING, true, false, null, null, \"hello\", \"one sentence\", null)" in s,
            "expected PromptField for text with STRING, required=true, example+instruction; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // Enum field: confidence (required, @values, @enumDoc)
    // -------------------------------------------------------------------------

    @Test fun emitsConfidenceEnumFieldWithValuesAndEnumDoc() {
        val (vo, tmpl) = loadVoAndTemplate()
        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue(
            "PromptField(\"confidence\", FieldKind.ENUM, true, false," in s,
            "expected FieldKind.ENUM for confidence, required=true; saw:\n$s"
        )

        assertTrue(
            "listOf(\"HIGH\", \"OK\", \"LOW\")" in s,
            "expected listOf with enum values; saw:\n$s"
        )

        assertTrue(
            "\"HIGH\" to \"Directly supported.\"" in s,
            "expected enumDoc HIGH entry; saw:\n$s"
        )

        assertTrue(
            "\"OK\" to \"Inference.\"" in s,
            "expected enumDoc OK entry; saw:\n$s"
        )

        // Keys sorted alphabetically: HIGH before OK.
        val highIdx = s.indexOf("\"HIGH\" to")
        val okIdx   = s.indexOf("\"OK\" to")
        assertTrue(highIdx < okIdx, "enumDoc keys should be sorted: HIGH before OK; saw:\n$s")
    }

    @Test fun enumDocUsesMapOf() {
        val (vo, tmpl) = loadVoAndTemplate()
        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue(
            "mapOf(" in s,
            "expected mapOf(...) for enumDoc; saw:\n$s"
        )
    }

    @Test fun enumDocNullWhenAbsent() {
        // A fixture with @enumAlias but no @enumDoc — enumDoc should be null.
        val fx = """
            {
              "metadata.root": { "package": "acme::noalias", "children": [
                { "object.value": { "name": "SimplePayload", "children": [
                    { "field.enum": { "name": "level", "@required": true,
                                      "@values": ["LOW","HIGH"],
                                      "@enumAlias": { "medium": "HIGH" } } }
                ] } },
                { "template.output": {
                    "name": "SimpleOutput",
                    "@payloadRef": "SimplePayload",
                    "@textRef": "test/simple",
                    "@format": "json"
                } }
              ] }
            }
        """.trimIndent()
        val loader = loadString("kofs-noalias", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::noalias::SimplePayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::noalias::SimpleOutput"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "SimplePayload")

        // The level field has @enumAlias but no @enumDoc, so enumDoc arg must be null.
        val confIdx = s.indexOf("\"level\"")
        assertTrue(confIdx >= 0, "expected level field; saw:\n$s")
        val confPart = s.substring(confIdx)
        assertTrue(
            confPart.startsWith("\"level\", FieldKind.ENUM, true, false, listOf(") &&
                confPart.contains("), null,"),
            "expected null enumDoc (position 6) for field with no @enumDoc; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // Optional field: note (string, no @example, no @instruction)
    // -------------------------------------------------------------------------

    @Test fun emitsNoteFieldAsOptionalWithNulls() {
        val (vo, tmpl) = loadVoAndTemplate()
        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue(
            "PromptField(\"note\", FieldKind.STRING, false, false, null, null, null, null, null)" in s,
            "expected PromptField for note, required=false, all nullable attrs null; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // Format mapping: JSON
    // -------------------------------------------------------------------------

    @Test fun jsonFormatEmitsFormatJson() {
        val fx = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "AnswerOutputPayload", "children": [
                    { "field.string": { "name": "text" } }
                ] } },
                { "template.output": {
                    "name": "AnswerOutput",
                    "@payloadRef": "AnswerOutputPayload",
                    "@textRef": "ai/answer",
                    "@format": "json"
                } }
              ] }
            }
        """.trimIndent()
        val loader = loadString("kofs-json", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::AnswerOutputPayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::AnswerOutput"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "AnswerOutputPayload")

        assertTrue("Format.JSON" in s, "expected Format.JSON for @format:json; saw:\n$s")
        assertFalse("Format.XML" in s, "must not contain Format.XML for @format:json; saw:\n$s")
    }

    // -------------------------------------------------------------------------
    // PromptStyle mapping
    // -------------------------------------------------------------------------

    @Test fun inlinePromptStyleEmitsInline() {
        val fx = """
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
        """.trimIndent()
        val loader = loadString("kofs-inline", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::StylePayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::StyleTemplate"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "StylePayload")

        assertTrue("PromptStyle.INLINE" in s, "expected PromptStyle.INLINE; saw:\n$s")
    }

    @Test fun exampleOnlyPromptStyleEmitsExampleOnly() {
        val fx = """
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
        """.trimIndent()
        val loader = loadString("kofs-exampleonly", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::StylePayload2"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::StyleTemplate2"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "StylePayload2")

        assertTrue("PromptStyle.EXAMPLE_ONLY" in s, "expected PromptStyle.EXAMPLE_ONLY; saw:\n$s")
    }

    @Test fun absentPromptStyleDefaultsToGuide() {
        val fx = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "DefaultPayload", "children": [
                    { "field.string": { "name": "z" } }
                ] } },
                { "template.output": {
                    "name": "DefaultTemplate",
                    "@payloadRef": "DefaultPayload",
                    "@textRef": "test/default",
                    "@format": "json"
                } }
              ] }
            }
        """.trimIndent()
        val loader = loadString("kofs-defaultstyle", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::DefaultPayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::DefaultTemplate"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "DefaultPayload")

        assertTrue("PromptStyle.GUIDE" in s, "absent @promptStyle should default to PromptStyle.GUIDE; saw:\n$s")
    }

    // -------------------------------------------------------------------------
    // Kotlin string escaping: @instruction containing a double-quote
    // -------------------------------------------------------------------------

    @Test fun instructionWithQuoteIsEscaped() {
        val fx = """
            {
              "metadata.root": { "package": "acme::test", "children": [
                { "object.value": { "name": "QuotePayload", "children": [
                    { "field.string": { "name": "msg", "@instruction": "say \"hi\"" } }
                ] } },
                { "template.output": {
                    "name": "QuoteTemplate",
                    "@payloadRef": "QuotePayload",
                    "@textRef": "test/quote",
                    "@format": "json"
                } }
              ] }
            }
        """.trimIndent()
        val loader = loadString("kofs-quote", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::test::QuotePayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::test::QuoteTemplate"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "QuotePayload")

        // The instruction value `say "hi"` must be emitted as `say \"hi\"` inside a Kotlin literal.
        assertTrue(
            "\"say \\\"hi\\\"\"" in s,
            "expected escaped double-quotes in instruction; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // Scalar type mapping — integer, long, double, boolean
    // -------------------------------------------------------------------------

    @Test fun scalarTypeKindMapping() {
        val fx = """
            {
              "metadata.root": { "package": "acme::types", "children": [
                { "object.value": { "name": "NumericPayload", "children": [
                    { "field.int":     { "name": "count"   } },
                    { "field.long":    { "name": "totalMs" } },
                    { "field.double":  { "name": "score"   } },
                    { "field.boolean": { "name": "valid"   } }
                ] } },
                { "template.output": {
                    "name": "NumericTemplate",
                    "@payloadRef": "NumericPayload",
                    "@textRef": "test/numeric",
                    "@format": "json"
                } }
              ] }
            }
        """.trimIndent()
        val loader = loadString("kofs-numeric", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::types::NumericPayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::types::NumericTemplate"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "NumericPayload")

        assertTrue("FieldKind.INT" in s,     "expected FieldKind.INT; saw:\n$s")
        assertTrue("FieldKind.LONG" in s,    "expected FieldKind.LONG; saw:\n$s")
        assertTrue("FieldKind.DOUBLE" in s,  "expected FieldKind.DOUBLE; saw:\n$s")
        assertTrue("FieldKind.BOOLEAN" in s, "expected FieldKind.BOOLEAN; saw:\n$s")
    }

    // -------------------------------------------------------------------------
    // Large enumDoc — mapOf has no arity cap in Kotlin (unlike Java Map.of limit of 10)
    // -------------------------------------------------------------------------

    @Test fun bigEnumDocUsesMapOf() {
        val fx = """
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
        """.trimIndent()
        val loader = loadString("kofs-bigdoc", fx)
        val vo = checkNotNull(loader.metaObjectOrNull("acme::ai::BigDocPayload"))
        val tmpl = checkNotNull(loader.outputTemplateOrNull("acme::ai::BigDocTemplate"))

        val s = KotlinOutputFormatSpecEmitter.specLiteral(vo, tmpl, "BigDocPayload")

        assertTrue("mapOf(" in s, "expected mapOf(...) for 12-entry enumDoc; saw:\n$s")

        // Count " to " occurrences within enumDoc — should be exactly 12.
        var count = 0
        var idx = 0
        while (idx < s.length) {
            val found = s.indexOf("\" to \"", idx)
            if (found == -1) break
            count++
            idx = found + 1
        }
        assertTrue(count == 12, "expected 12 `to` pairs in enumDoc; saw $count; output:\n$s")
    }
}
