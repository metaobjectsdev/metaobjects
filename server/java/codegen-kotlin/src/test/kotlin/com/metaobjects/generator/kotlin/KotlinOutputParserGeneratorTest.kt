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
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
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
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
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
            assertTrue("fun parseReply(text: String): ReplyPayload" in src, src)
            assertTrue("fun safeParseReply(text: String): Result<ReplyPayload>" in src, src)

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
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-ret-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-ret", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            // No data class redeclaration — the payload shape belongs to KotlinPayloadGenerator.
            assertFalse("data class ReplyPayload" in src,
                "parser file must NOT redeclare the payload data class; got:\n$src")
            // The decode call site uses the existing payload class.
            assertTrue("decodeFromString<ReplyPayload>(text)" in src, src)
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
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
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
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } },
            { "template.output": { "name": "Goodbye",
                "@payloadRef": "Farewell", "@textRef": "demo/goodbye" } }
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
            // (matches KotlinPayloadGenerator's `<TemplateShortName>Payload` convention),
            // NOT from the @payloadRef VO name. The parser file therefore decodes into
            // <TemplateShortName>Payload regardless of which VO was the @payloadRef target.
            assertTrue("decodeFromString<ReplyPayload>" in reply, reply)
            assertTrue("decodeFromString<GoodbyePayload>" in goodbye, goodbye)
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
    // 7. FR-010: json format emits recover() + RECOVER_SCHEMA + Recovered class.
    // ---------------------------------------------------------------------------
    @Test fun jsonFormatEmitsRecoverBlock() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string":  { "name": "text",       "@required": true } },
                { "field.enum":    { "name": "confidence", "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@enumAlias": { "medium": "OK" } } },
                { "field.string":  { "name": "note" } }
            ] } },
            { "template.output": { "name": "Answer",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-json-recover-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-json-recover", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/AnswerParser.kt"))

            // Recovered data class emitted at top level.
            assertTrue("data class AnswerRecovered(" in src, "missing Recovered class decl; src:\n$src")

            // RECOVER_SCHEMA constant inside the object.
            assertTrue("RECOVER_SCHEMA" in src, "missing RECOVER_SCHEMA; src:\n$src")

            // Two recover() overloads.
            assertTrue("fun recover(text: String): RecoveryResult<" in src,
                "missing recover(String) overload; src:\n$src")
            assertTrue("fun recover(text: String, opts: RecoverOptions)" in src,
                "missing recover(String, RecoverOptions) overload; src:\n$src")

            // Engine call site.
            assertTrue("Recover.recover(text, RECOVER_SCHEMA" in src,
                "missing Recover.recover(...) call site; src:\n$src")

            // Kotlin property access on RecoverOutcome (not method call).
            assertTrue("val d = o.data" in src, "expected o.data property access; src:\n$src")
            assertTrue("o.report" in src, "expected o.report property access; src:\n$src")

            // Recover imports.
            assertTrue("import com.metaobjects.render.recover.Recover" in src,
                "missing Recover import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.RecoveryResult" in src,
                "missing RecoveryResult import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.RecoverOptions" in src,
                "missing RecoverOptions import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.RecoverSchema" in src,
                "missing RecoverSchema import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.RecoverMap" in src,
                "missing RecoverMap import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.FieldSpec" in src,
                "missing FieldSpec import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.FieldKind" in src,
                "missing FieldKind import; src:\n$src")
            assertTrue("import com.metaobjects.render.recover.Format" in src,
                "missing Format import; src:\n$src")

            // Existing parse/safeParse API must still be present.
            assertTrue("fun parseAnswer" in src, "missing fun parseAnswer; src:\n$src")
            assertTrue("fun safeParseAnswer" in src, "missing fun safeParseAnswer; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 8. FR-010: Recovered class name follows <TemplateShort>Recovered convention.
    // ---------------------------------------------------------------------------
    @Test fun recoveredClassNameFollowsTemplateShortConvention() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.output": { "name": "Answer",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-recovered-name-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-recovered-name", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/AnswerParser.kt"))

            // Recovered class name = templateShort + "Recovered" = "AnswerRecovered".
            assertTrue("data class AnswerRecovered(" in src,
                "Recovered class name must be <TemplateShort>Recovered = AnswerRecovered; src:\n$src")
            assertTrue("RecoveryResult<AnswerRecovered>" in src,
                "recover() return type must be RecoveryResult<AnswerRecovered>; src:\n$src")

            // Must NOT redeclare the payload data class.
            assertFalse("data class AnswerPayload" in src,
                "parser must not redeclare the payload data class; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 9. FR-010: text format (default) does NOT emit recover / RECOVER_SCHEMA.
    // ---------------------------------------------------------------------------
    @Test fun textFormatDoesNotEmitRecoverBlock() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting",
                "@textRef": "demo/reply",
                "@format": "text" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-text-norecover-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-text-norecover", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            assertFalse("recover" in src,
                "text format must NOT emit recover; src:\n$src")
            assertFalse("RECOVER_SCHEMA" in src,
                "text format must NOT emit RECOVER_SCHEMA; src:\n$src")
            assertFalse("RecoveryResult" in src,
                "text format must NOT emit RecoveryResult; src:\n$src")

            // parse/safeParse still present.
            assertTrue("fun parseReply" in src, "fun parseReply must still be present; src:\n$src")
            assertTrue("fun safeParseReply" in src, "fun safeParseReply must still be present; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 10. FR-010: xml format also emits recover block (same gate as json).
    // ---------------------------------------------------------------------------
    @Test fun xmlFormatEmitsRecoverBlock() {
        val fx = """{
          "metadata.root": { "package": "acme::reports", "children": [
            { "object.value": { "name": "SummaryOutputPayload", "children": [
                { "field.string": { "name": "body" } }
            ] } },
            { "template.output": { "name": "Summary",
                "@payloadRef": "SummaryOutputPayload",
                "@textRef": "reports/summary",
                "@format": "xml" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-xml-recover-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-xml-recover", fx))

            val src = Files.readString(outDir.resolve("acme/reports/prompts/SummaryParser.kt"))

            assertTrue("data class SummaryRecovered(" in src,
                "xml format must emit Recovered class; src:\n$src")
            assertTrue("RECOVER_SCHEMA" in src,
                "xml format must emit RECOVER_SCHEMA; src:\n$src")
            assertTrue("Format.XML" in src,
                "xml format must use Format.XML in schema literal; src:\n$src")
            assertTrue("fun recover(text: String): RecoveryResult<" in src,
                "xml format must emit recover() overload; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 11. FR-010: no @format (default=text) behaves the same as @format=text.
    // ---------------------------------------------------------------------------
    @Test fun noFormatAttrDefaultsToTextAndNoRecover() {
        // The existing fixtures (tests 1-6) omit @format, which defaults to "text".
        // This test makes the no-recover contract explicit for the default case.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kparser-noformat-norecover-")
        try {
            val gen = KotlinOutputParserGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-noformat-norecover", fx))

            val src = Files.readString(outDir.resolve("acme/demo/prompts/ReplyParser.kt"))

            assertFalse("RECOVER_SCHEMA" in src,
                "absent @format (defaults to text) must not emit RECOVER_SCHEMA; src:\n$src")
            assertFalse("RecoveryResult" in src,
                "absent @format must not emit RecoveryResult; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
