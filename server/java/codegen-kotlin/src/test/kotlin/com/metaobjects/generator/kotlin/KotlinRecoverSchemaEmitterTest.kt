package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.metadata.ktx.metaObjectOrNull
import com.metaobjects.`object`.MetaObject
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for [KotlinRecoverSchemaEmitter] — FR-010 Kotlin port of the
 * VO-to-recover-schema source-string helper.
 *
 * Fixture: `object.value` `AnswerOutputPayload` (pkg `acme::ai`) with:
 * - `text`       (field.string, @required true)
 * - `confidence` (field.enum,   @required true, @values [HIGH, OK, LOW], @enumAlias {medium: OK})
 * - `note`       (field.string, optional)
 *
 * Mirrors the Java `RecoverSchemaEmitterTest` contract adapted for Kotlin collection
 * literals (`listOf`, `mapOf`) and Kotlin record-constructor syntax.
 */
class KotlinRecoverSchemaEmitterTest {

    private val fixture = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string":  { "name": "text",       "@required": true } },
                { "field.enum":    { "name": "confidence", "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@enumAlias": { "medium": "OK" } } },
                { "field.string":  { "name": "note" } }
            ] } }
          ] }
        }
    """.trimIndent()

    private fun vo(): MetaObject {
        val loader = loadString("kr-test", fixture)
        return checkNotNull(loader.metaObjectOrNull("acme::ai::AnswerOutputPayload")) {
            "AnswerOutputPayload not found in loader"
        }
    }

    // -------------------------------------------------------------------------
    // schemaLiteral tests
    // -------------------------------------------------------------------------

    @Test fun schemaLiteralEmitsRecoverSchemaWithJsonFormat() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue(
            "RecoverSchema(Format.JSON, \"AnswerOutputPayload\"" in s,
            "expected RecoverSchema(Format.JSON, \"AnswerOutputPayload\"; saw:\n$s"
        )
    }

    @Test fun schemaLiteralEmitsScalarForTextField() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue(
            "FieldSpec.scalar(\"text\", FieldKind.STRING, true)" in s,
            "expected scalar for required text field; saw:\n$s"
        )
    }

    @Test fun schemaLiteralEmitsEnumFieldForConfidence() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue(
            "FieldSpec.enumField(\"confidence\", true," in s,
            "expected enumField for confidence; saw:\n$s"
        )
    }

    @Test fun schemaLiteralEnumValuesUseListOf() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue("listOf(\"HIGH\", \"OK\", \"LOW\")" in s,
            "expected listOf with enum values; saw:\n$s")
    }

    @Test fun schemaLiteralAliasMapUsesMapOf() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue(
            "mapOf(\"medium\" to \"OK\")" in s,
            "expected mapOf(\"medium\" to \"OK\") alias literal; saw:\n$s"
        )
    }

    @Test fun schemaLiteralEmitsOptionalScalarForNoteField() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "json", "AnswerOutputPayload")

        assertTrue(
            "FieldSpec.scalar(\"note\", FieldKind.STRING, false)" in s,
            "expected scalar for optional note field; saw:\n$s"
        )
    }

    @Test fun schemaLiteralXmlFormatProducesFormatXml() {
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(vo(), "xml", "AnswerOutputPayload")

        assertTrue(
            "RecoverSchema(Format.XML, \"AnswerOutputPayload\"" in s,
            "expected Format.XML for xml format; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // recoveredClassDecl tests
    // -------------------------------------------------------------------------

    @Test fun recoveredClassDeclEmitsDataClass() {
        val s = KotlinRecoverSchemaEmitter.recoveredClassDecl(vo(), "AnswerOutputRecovered")

        assertTrue(
            "data class AnswerOutputRecovered(" in s,
            "expected data class declaration; saw:\n$s"
        )
    }

    @Test fun recoveredClassDeclTextIsNullableString() {
        val s = KotlinRecoverSchemaEmitter.recoveredClassDecl(vo(), "AnswerOutputRecovered")

        assertTrue(
            "val text: String? = null" in s,
            "expected val text: String? = null; saw:\n$s"
        )
    }

    @Test fun recoveredClassDeclConfidenceIsNullableString() {
        val s = KotlinRecoverSchemaEmitter.recoveredClassDecl(vo(), "AnswerOutputRecovered")

        assertTrue(
            "val confidence: String? = null" in s,
            "expected val confidence: String? = null (enum → String?); saw:\n$s"
        )
    }

    @Test fun recoveredClassDeclNoteIsNullableString() {
        val s = KotlinRecoverSchemaEmitter.recoveredClassDecl(vo(), "AnswerOutputRecovered")

        assertTrue(
            "val note: String? = null" in s,
            "expected val note: String? = null; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // recoveredCtorArgs tests
    // -------------------------------------------------------------------------

    @Test fun recoveredCtorArgsUsesAsStringForText() {
        val a = KotlinRecoverSchemaEmitter.recoveredCtorArgs(vo())

        assertTrue(
            "RecoverMap.asString(d, \"text\")" in a,
            "expected asString for text; saw:\n$a"
        )
    }

    @Test fun recoveredCtorArgsUsesAsStringForConfidence() {
        val a = KotlinRecoverSchemaEmitter.recoveredCtorArgs(vo())

        assertTrue(
            "RecoverMap.asString(d, \"confidence\")" in a,
            "expected asString for confidence (enum-backed); saw:\n$a"
        )
    }

    @Test fun recoveredCtorArgsUsesAsStringForNote() {
        val a = KotlinRecoverSchemaEmitter.recoveredCtorArgs(vo())

        assertTrue(
            "RecoverMap.asString(d, \"note\")" in a,
            "expected asString for note; saw:\n$a"
        )
    }

    // -------------------------------------------------------------------------
    // Scalar type mapping tests — integer, long, double, boolean
    // -------------------------------------------------------------------------

    @Test fun schemaLiteralIntegerFieldMapsToIntKind() {
        val fx = """
            {
              "metadata.root": { "package": "acme::types", "children": [
                { "object.value": { "name": "NumericPayload", "children": [
                    { "field.int":     { "name": "count"   } },
                    { "field.long":    { "name": "totalMs" } },
                    { "field.double":  { "name": "score"   } },
                    { "field.boolean": { "name": "valid"   } }
                ] } }
              ] }
            }
        """.trimIndent()

        val numVo = checkNotNull(loadString("kr-numeric", fx)
            .metaObjectOrNull("acme::types::NumericPayload"))

        val s = KotlinRecoverSchemaEmitter.schemaLiteral(numVo, "json", "NumericPayload")

        assertTrue("FieldKind.INT" in s,    "expected FieldKind.INT; saw:\n$s")
        assertTrue("FieldKind.LONG" in s,   "expected FieldKind.LONG; saw:\n$s")
        assertTrue("FieldKind.DOUBLE" in s, "expected FieldKind.DOUBLE; saw:\n$s")
        assertTrue("FieldKind.BOOLEAN" in s,"expected FieldKind.BOOLEAN; saw:\n$s")
    }

    @Test fun recoveredCtorArgsNumericTypes() {
        val fx = """
            {
              "metadata.root": { "package": "acme::types", "children": [
                { "object.value": { "name": "NumericPayload", "children": [
                    { "field.int":     { "name": "count"   } },
                    { "field.long":    { "name": "totalMs" } },
                    { "field.double":  { "name": "score"   } },
                    { "field.boolean": { "name": "valid"   } }
                ] } }
              ] }
            }
        """.trimIndent()

        val numVo = checkNotNull(loadString("kr-numeric-args", fx)
            .metaObjectOrNull("acme::types::NumericPayload"))

        val a = KotlinRecoverSchemaEmitter.recoveredCtorArgs(numVo)

        assertTrue("RecoverMap.asInt(d, \"count\")"    in a, "expected asInt; saw:\n$a")
        assertTrue("RecoverMap.asLong(d, \"totalMs\")" in a, "expected asLong; saw:\n$a")
        assertTrue("RecoverMap.asDouble(d, \"score\")" in a, "expected asDouble; saw:\n$a")
        assertTrue("RecoverMap.asBool(d, \"valid\")"   in a, "expected asBool; saw:\n$a")
    }

    // -------------------------------------------------------------------------
    // Empty alias map — must emit mapOf() not mapOf(...)
    // -------------------------------------------------------------------------

    @Test fun enumWithNoAliasEmitsEmptyMapOf() {
        val fx = """
            {
              "metadata.root": { "package": "acme::noalias", "children": [
                { "object.value": { "name": "SimpleEnum", "children": [
                    { "field.enum": { "name": "level",
                                      "@values": ["LOW","HIGH"] } }
                ] } }
              ] }
            }
        """.trimIndent()

        val simpleVo = checkNotNull(loadString("kr-noalias", fx)
            .metaObjectOrNull("acme::noalias::SimpleEnum"))

        val s = KotlinRecoverSchemaEmitter.schemaLiteral(simpleVo, "json", "SimpleEnum")

        assertTrue("mapOf()" in s, "expected empty mapOf() for no-alias enum; saw:\n$s")
    }

    // -------------------------------------------------------------------------
    // FR-011 — @coerceDefault + resolved @normalize emission
    // -------------------------------------------------------------------------

    @Test fun schemaLiteralEmitsFr011CoerceDefaultAndResolvedNormalize() {
        val fx = """
            {
              "metadata.root": { "package": "acme::ai", "children": [
                { "object.value": { "name": "Fr011Payload", "@normalize": "collapse", "children": [
                    { "field.enum": { "name": "status", "@required": true,
                                      "@values": ["HIGH","OK","LOW"],
                                      "@coerceDefault": "LOW" } },
                    { "field.enum": { "name": "phase", "@required": true,
                                      "@values": ["HIGH","OK","LOW"],
                                      "@normalize": "none" } },
                    { "field.enum": { "name": "plain", "@required": false,
                                      "@values": ["HIGH","OK","LOW"] } }
                ] } }
              ] }
            }
        """.trimIndent()

        val voFr = checkNotNull(loadString("kr-fr011", fx)
            .metaObjectOrNull("acme::ai::Fr011Payload"))
        val s = KotlinRecoverSchemaEmitter.schemaLiteral(voFr, "json", "Fr011Payload")

        // status: coerceDefault="LOW", normalize resolves to the object default "collapse".
        assertTrue(
            "FieldSpec.enumField(\"status\", true, listOf(\"HIGH\", \"OK\", \"LOW\"), mapOf(), \"LOW\", \"collapse\", null)" in s,
            "expected status 7-arg form with coerceDefault LOW + normalize collapse; saw:\n$s"
        )
        // phase: own @normalize="none" overrides the object default.
        assertTrue(
            "FieldSpec.enumField(\"phase\", true, listOf(\"HIGH\", \"OK\", \"LOW\"), mapOf(), null, \"none\", null)" in s,
            "expected phase 7-arg form with normalize none; saw:\n$s"
        )
        // plain: inherits object "collapse" → still 7-arg (mode != strip).
        assertTrue(
            "FieldSpec.enumField(\"plain\", false, listOf(\"HIGH\", \"OK\", \"LOW\"), mapOf(), null, \"collapse\", null)" in s,
            "expected plain 7-arg form with inherited normalize collapse; saw:\n$s"
        )
    }

    // -------------------------------------------------------------------------
    // kotlinStringLiteral helper
    // -------------------------------------------------------------------------

    @Test fun kotlinStringLiteralEscapesSpecialChars() {
        // Verify the escaping helper correctly handles backslash, quote, newline, tab, CR.
        val escaped = KotlinRecoverSchemaEmitter.kotlinStringLiteral("a\\b\"c\nd\te\r")
        assertTrue("a\\\\b" in escaped, "backslash should be escaped; saw: $escaped")
        assertTrue("\\\"c"  in escaped, "double-quote should be escaped; saw: $escaped")
        assertTrue("\\n"    in escaped, "newline should be escaped; saw: $escaped")
        assertTrue("\\t"    in escaped, "tab should be escaped; saw: $escaped")
        assertTrue("\\r"    in escaped, "CR should be escaped; saw: $escaped")
    }

    @Test fun kotlinStringLiteralEscapesDollarSign() {
        // Bug 1: a bare $ in a string value must be emitted as \$ in the generated Kotlin
        // source to prevent string-template injection (e.g. "$amount" would cause
        // an unresolved-reference compile error in the consumer's generated code).
        val escaped = KotlinRecoverSchemaEmitter.kotlinStringLiteral("cost is \$amount")
        assertTrue(
            "cost is \\\$amount" in escaped,
            "dollar sign must be escaped to \\$ in output; saw: $escaped"
        )
        // Also ensure the backslash before $ was NOT double-escaped (no \\\\$).
        assertTrue(
            "\\\\$" !in escaped,
            "dollar's backslash must not be double-escaped; saw: $escaped"
        )
    }

    // -------------------------------------------------------------------------
    // isArray + EnumField: recoveredClassDecl / recoveredCtorArgs consistency
    // -------------------------------------------------------------------------

    @Test fun isArrayEnumFieldUsesListStringTypeAndAsStringList() {
        // Bug 2: for a field that is BOTH EnumField AND isArray=true,
        // nullableTypeName must return List<String>? and
        // constructorArgForField must return RecoverMap.asStringList(...).
        // Previously constructorArgForField checked EnumField first → asString() mismatch.
        val fx = """
            {
              "metadata.root": { "package": "acme::arrenum", "children": [
                { "object.value": { "name": "TagPayload", "children": [
                    { "field.enum": { "name": "tags", "@values": ["A","B"], "isArray": true } }
                ] } }
              ] }
            }
        """.trimIndent()

        val tagVo = checkNotNull(loadString("kr-arrenum", fx)
            .metaObjectOrNull("acme::arrenum::TagPayload"))

        val decl = KotlinRecoverSchemaEmitter.recoveredClassDecl(tagVo, "TagPayloadRecovered")
        assertTrue(
            "val tags: List<String>? = null" in decl,
            "isArray enum field must use List<String>? type; saw:\n$decl"
        )

        val args = KotlinRecoverSchemaEmitter.recoveredCtorArgs(tagVo)
        assertTrue(
            "RecoverMap.asStringList(d, \"tags\")" in args,
            "isArray enum field must use asStringList, not asString; saw:\n$args"
        )
        assertTrue(
            "RecoverMap.asString(d, \"tags\")" !in args,
            "isArray enum field must NOT use asString; saw:\n$args"
        )
    }
}
