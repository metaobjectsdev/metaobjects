package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for [KotlinOutputParserGenerator] — FR-006 typed parser codegen for
 * `template.output` nodes. Mirrors the cross-port semantics:
 *
 *  - one `<TemplateShortName>Parser.kt` per `template.output` (NOT per `template.prompt`),
 *  - emitted into the same package as the payload class (`<entity-pkg>.prompts`),
 *  - dual API: `parseXxx` (throws `SerializationException`) + `safeParseXxx`
 *    (returns `kotlin.Result<XxxPayload>`),
 *  - return type references the payload data class emitted by
 *    [KotlinPayloadGenerator] (no re-declaration of the payload shape),
 *  - skips defensively when `@payloadRef` cannot be resolved.
 */
class KotlinOutputParserGeneratorTest {

    // ---------------------------------------------------------------------------
    // 1. Emits parser only for template.output (NOT for template.prompt).
    // ---------------------------------------------------------------------------
    @Test fun emitsParserOnlyForTemplateOutput() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "WelcomePrompt",
                "@payloadRef": "Greeting", "@textRef": "demo/welcome" } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-mix-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-mix", fx))

            val parser = outDir.resolve("acme/demo/prompts/ReplyParser.kt")
            val promptParser = outDir.resolve("acme/demo/prompts/WelcomePromptParser.kt")
            assertTrue(Files.exists(parser),
                "expected $parser; files=${Files.walk(outDir).toList()}")
            assertFalse(Files.exists(promptParser),
                "template.prompt should NOT emit a parser; found $promptParser")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 2. Generated source has the expected dual API + correct imports.
    // ---------------------------------------------------------------------------
    @Test fun emitsDualApiWithExpectedShape() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-api-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-api", fx))

            val parser = outDir.resolve("acme/demo/prompts/ReplyParser.kt")
            val src = Files.readString(parser)

            // Dual API surface
            assertTrue("object ReplyParser" in src, src)
            assertTrue("fun parseReply(text: String): ReplyResponse" in src, src)
            assertTrue("fun safeParseReply(text: String): Result<ReplyResponse>" in src, src)

            // Imports — only the Json import is needed; SerializationException
            // is referenced via FQN in the KDoc so consumers with `-Werror`
            // don't trip on an unused-import warning.
            assertTrue("import kotlinx.serialization.json.Json" in src, src)
            assertTrue("@throws kotlinx.serialization.SerializationException" in src, src)

            // Package matches KotlinPayloadGenerator's `<entity-pkg>.prompts` convention.
            assertTrue("package acme.demo.prompts" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 3. Return type references the existing payload class (no re-declaration).
    // ---------------------------------------------------------------------------
    @Test fun returnTypeReferencesExistingPayloadClass() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-ret-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-ret", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            // No data class redeclaration — the payload shape belongs to KotlinPayloadGenerator.
            assertFalse("data class ReplyResponse" in src,
                "parser file must NOT redeclare the payload data class; got:\n$src")
            // The decode call site uses the existing payload class.
            assertTrue("decodeFromString<ReplyResponse>(text)" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 4. Resolvable cases emit; the generator's defensive skip paths
    //    (missing/non-VO @payloadRef) are unreachable through normal `loadString`
    //    because the loader's ValidationPhase hard-rejects those metadata
    //    configurations at load time (ERR_INVALID_TEMPLATE). The generator's
    //    null-guards therefore exist as cross-port-symmetric belt-and-suspenders
    //    code paths (mirroring KotlinPayloadGenerator, C# OutputParserGenerator,
    //    Python output_parser_generator), but can't be tested end-to-end without
    //    bypassing the loader — out of scope for this unit suite.
    // ---------------------------------------------------------------------------
    @Test fun resolvablePayloadRefEmits() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-resolvable-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-resolvable", fx))

            assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/ReplyParser.kt")))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 5. Multiple template.outputs → one parser file per output.
    // ---------------------------------------------------------------------------
    @Test fun emitsOneFilePerTemplateOutput() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "object.value": { "name": "Farewell", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } },
            { "template.prompt": { "name": "Goodbye",
                "@payloadRef": "Farewell", "@responseRef": "Farewell", "@textRef": "demo/goodbye" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-multi-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-multi", fx))

            assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/ReplyParser.kt")))
            assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/GoodbyeParser.kt")))

            val reply = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))
            val goodbye = Files.readString(outDir.resolve("acme/demo/prompts/GoodbyeParser.kt"))
            // The payload class name is derived from the TEMPLATE short name
            // (ADR-0052: the parser binds `<TemplateShortName>Response` — the @responseRef shape),
            // NOT from the @payloadRef VO name. The parser file therefore decodes into
            // <TemplateShortName>Response regardless of which VO was the @responseRef target.
            assertTrue("decodeFromString<ReplyResponse>" in reply, reply)
            assertTrue("decodeFromString<GoodbyeResponse>" in goodbye, goodbye)
            // Sanity — the parser names follow the template, not the VO.
            assertTrue("object ReplyParser" in reply, reply)
            assertTrue("object GoodbyeParser" in goodbye, goodbye)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 6. No emission for a fixture with only template.prompt (no-op).
    // ---------------------------------------------------------------------------
    @Test fun noEmissionForPromptOnlyFixture() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "WelcomePrompt",
                "@payloadRef": "Greeting", "@textRef": "demo/welcome" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-prompt-only-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-prompt-only", fx))

            // Zero files written.
            val emitted = Files.walk(outDir).filter { Files.isRegularFile(it) }.toList()
            assertEquals(0, emitted.size,
                "expected zero files for a prompt-only fixture; got: $emitted")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 7. FR-010: json format emits the loader-delegating extractLenient() + Extracted class
    //    (Move 1: no baked EXTRACT_SCHEMA / self-contained overload).
    // ---------------------------------------------------------------------------
    @Test fun jsonFormatEmitsExtractLenientBlock() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string":  { "name": "text",       "@required": true } },
                { "field.enum":    { "name": "confidence", "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@enumAlias": { "medium": "OK" } } },
                { "field.string":  { "name": "note" } }
            ] } },
            { "template.prompt": { "name": "Answer",
                "@payloadRef": "AnswerOutputPayload", "@responseRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "text", "@responseFormat": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-json-extract-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-json-extract", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/AnswerParser.kt"))

            // Extracted data class emitted at top level.
            assertTrue("data class AnswerExtracted(" in src, "missing Extracted class decl; src:\n$src")

            // The single metadata-driven extract path: loader-delegating overload only.
            assertTrue("fun extractLenient(loader: MetaDataLoader, text: String" in src,
                "missing loader-delegating extractLenient overload; src:\n$src")
            assertTrue("MetaObjectExtractor.extract(mo, text" in src,
                "missing MetaObjectExtractor delegation; src:\n$src")
            assertTrue("PAYLOAD_FQN" in src, "missing PAYLOAD_FQN constant; src:\n$src")
            assertTrue("raw.report" in src, "delegating overload should map raw.report; src:\n$src")

            // No baked snapshot survives (Move 1).
            assertFalse("EXTRACT_SCHEMA" in src, "baked EXTRACT_SCHEMA must be gone; src:\n$src")
            assertFalse("fun extractLenient(text: String)" in src,
                "self-contained extractLenient(String) overload must be gone; src:\n$src")
            assertFalse("Extract.extract(" in src, "baked Extract.extract call must be gone; src:\n$src")

            // Imports for the delegating path; the baked-only ones must be gone.
            assertTrue("import com.metaobjects.render.extract.ExtractionResult" in src,
                "missing ExtractionResult import; src:\n$src")
            assertTrue("import com.metaobjects.render.extract.ExtractOptions" in src,
                "missing ExtractOptions import; src:\n$src")
            assertTrue("import com.metaobjects.render.extract.ExtractMap" in src,
                "missing ExtractMap import; src:\n$src")
            assertTrue("import com.metaobjects.render.extract.Format" in src,
                "missing Format import; src:\n$src")
            assertTrue("import com.metaobjects.loader.MetaDataLoader" in src,
                "missing MetaDataLoader import; src:\n$src")
            assertFalse("import com.metaobjects.render.extract.ExtractSchema" in src,
                "ExtractSchema import must be gone; src:\n$src")
            assertFalse("import com.metaobjects.render.extract.FieldSpec" in src,
                "FieldSpec import must be gone; src:\n$src")
            assertFalse("import com.metaobjects.render.extract.FieldKind" in src,
                "FieldKind import must be gone; src:\n$src")
            assertFalse("import com.metaobjects.render.extract.Extract\n" in src,
                "Extract import must be gone; src:\n$src")

            // Existing parse/safeParse API must still be present.
            assertTrue("fun parseAnswer" in src, "missing fun parseAnswer; src:\n$src")
            assertTrue("fun safeParseAnswer" in src, "missing fun safeParseAnswer; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 8. FR-010: Extracted class name follows <TemplateShort>Extracted convention.
    // ---------------------------------------------------------------------------
    @Test fun extractedClassNameFollowsTemplateShortConvention() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Answer",
                "@payloadRef": "AnswerOutputPayload", "@responseRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "text", "@responseFormat": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-extracted-name-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-extracted-name", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/AnswerParser.kt"))

            // Extracted class name = templateShort + "Extracted" = "AnswerExtracted".
            assertTrue("data class AnswerExtracted(" in src,
                "Extracted class name must be <TemplateShort>Extracted = AnswerExtracted; src:\n$src")
            assertTrue("ExtractionResult<AnswerExtracted>" in src,
                "extractLenient() return type must be ExtractionResult<AnswerExtracted>; src:\n$src")

            // Must NOT redeclare the payload data class.
            assertFalse("data class AnswerPayload" in src,
                "parser must not redeclare the payload data class; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 9. FR-010: text format (default) does NOT emit extract / EXTRACT_SCHEMA.
    // ---------------------------------------------------------------------------
        // ADR-0052: the tolerant tier is emitted for EVERY responding prompt — declaring a
    // response shape IS the request for one. This previously asserted the opposite, keyed on
    // @format, which is the syntax of the prompt BODY and says nothing about the reply.
    @Test fun textBodiedPromptStillEmitsExtractLenient() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting",
                "@textRef": "demo/reply",
                "@format": "text" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-text-noextract-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-text-noextract", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            // The tolerant tier IS emitted: @responseRef is declared, and @format never had a
            // say in it. Absent @responseFormat defaults to json (ADR-0053).
            assertTrue("ExtractionResult" in src,
                "a responding prompt must emit the tolerant extract whatever its @format; src:\n$src")
            assertTrue("Format.JSON" in src,
                "absent @responseFormat must default to Format.JSON; src:\n$src")
            assertFalse("EXTRACT_SCHEMA" in src,
                "no baked ExtractSchema literal survives; src:\n$src")

            // The strict tier is present too — json replies get both.
            assertTrue("fun parseReply" in src, "fun parseReply must still be present; src:\n$src")
            assertTrue("fun safeParseReply" in src, "fun safeParseReply must still be present; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 10. FR-010: xml format also emits extract block (same gate as json).
    // ---------------------------------------------------------------------------
    @Test fun xmlFormatEmitsExtractLenientBlock() {
        val fx = """{
          "metadata.root": { "package": "acme::reports", "children": [
            { "object.value": { "name": "SummaryOutputPayload", "children": [
                { "field.string": { "name": "body" } }
            ] } },
            { "template.prompt": { "name": "Summary",
                "@payloadRef": "SummaryOutputPayload", "@responseRef": "SummaryOutputPayload",
                "@textRef": "reports/summary",
                "@format": "text", "@responseFormat": "xml" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-xml-extract-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-xml-extract", fx))

            val src = Files.readString(outDir.resolve("acme/reports/prompts/SummaryParser.kt"))

            assertTrue("data class SummaryExtracted(" in src,
                "xml format must emit Extracted class; src:\n$src")
            assertFalse("EXTRACT_SCHEMA" in src,
                "xml format must NOT emit a baked EXTRACT_SCHEMA (Move 1); src:\n$src")
            assertTrue("Format.XML" in src,
                "xml format must pass Format.XML to the runtime extractor; src:\n$src")
            assertTrue("fun extractLenient(loader: MetaDataLoader, text: String" in src,
                "xml format must emit the loader-delegating extractLenient overload; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 11. FR-010: no @format (default=text) behaves the same as @format=text.
    // ---------------------------------------------------------------------------
        // Companion pin: no @format at all still emits the tolerant tier.
    @Test fun absentFormatStillEmitsExtractLenient() {
        // The existing fixtures (tests 1-6) omit @format, which defaults to "text". ADR-0052:
        // that never had any bearing on the tolerant tier — @format is the syntax of the prompt
        // BODY. Declaring @responseRef IS the request for the tier, and the reply's syntax
        // defaults to json via @responseFormat.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "Reply",
                "@payloadRef": "Greeting", "@responseRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-noformat-noextract-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-noformat-noextract", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            assertFalse("EXTRACT_SCHEMA" in src,
                "no baked ExtractSchema literal survives; src:\n$src")
            assertTrue("ExtractionResult" in src,
                "a responding prompt must emit the tolerant extract; src:\n$src")
            assertTrue("Format.JSON" in src,
                "absent @responseFormat must default to Format.JSON; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
