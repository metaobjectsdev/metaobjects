package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for [KotlinOutputPromptGenerator] — FR-010 prompt-fragment codegen for
 * `template.output` nodes. Mirrors the cross-port semantics:
 *
 *  - one `<TemplateShortName>Prompt.kt` per `template.output` (NOT per `template.prompt`),
 *  - only emitted for `@format` json or xml (text → no-op),
 *  - emitted into the same package as the payload class (`<entity-pkg>.prompts`),
 *  - Kotlin `object` with `renderFormat()` + `renderFormat(overrides: PromptOverrides)`,
 *  - backed by `OutputFormatRenderer.render(SPEC, ...)` with an inline `OutputFormatSpec`.
 */
class KotlinOutputPromptGeneratorTest {

    // ---------------------------------------------------------------------------
    // 1. Emits prompt only for template.output (NOT for template.prompt).
    // ---------------------------------------------------------------------------
    @Test fun emitsPromptOnlyForTemplateOutput() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.prompt": { "name": "WelcomePrompt",
                "@payloadRef": "Greeting", "@textRef": "demo/welcome" } },
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply",
                "@format": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kprompt-mix-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-prompt-mix", fx))

            val prompt = outDir.resolve("acme/demo/prompts/ReplyPrompt.kt")
            val promptPrompt = outDir.resolve("acme/demo/prompts/WelcomePromptPrompt.kt")
            assertTrue(Files.exists(prompt),
                "expected $prompt; files=${Files.walk(outDir).toList()}")
            assertFalse(Files.exists(promptPrompt),
                "template.prompt should NOT emit a prompt file; found $promptPrompt")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 2. JSON format emits prompt object with expected shape.
    // ---------------------------------------------------------------------------
    @Test fun jsonFormatEmitsPromptObjectWithExpectedShape() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string": { "name": "text",       "@required": true } },
                { "field.string": { "name": "note" } }
            ] } },
            { "template.output": { "name": "Answer",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "json" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kprompt-json-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-json-prompt", fx))

            val promptFile = outDir.resolve("acme/ai/prompts/AnswerPrompt.kt")
            assertTrue(Files.exists(promptFile),
                "expected AnswerPrompt.kt; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(promptFile)

            // Object declaration
            assertTrue("object AnswerPrompt" in src, "missing object AnswerPrompt; src:\n$src")

            // SPEC constant
            assertTrue("private val SPEC: OutputFormatSpec =" in src,
                "missing SPEC constant; src:\n$src")

            // renderFormat() — no-arg overload delegates to PromptOverrides.none()
            assertTrue("OutputFormatRenderer.render(SPEC, PromptOverrides.none())" in src,
                "missing renderFormat() no-arg call; src:\n$src")

            // renderFormat(overrides) — overload
            assertTrue("fun renderFormat(overrides: PromptOverrides): String = OutputFormatRenderer.render(SPEC, overrides)" in src,
                "missing renderFormat(overrides) overload; src:\n$src")

            // Package matches <entity-pkg>.prompts convention
            assertTrue("package acme.ai.prompts" in src, "wrong package; src:\n$src")

            // Imports present
            assertTrue("import com.metaobjects.render.prompt.OutputFormatRenderer" in src, src)
            assertTrue("import com.metaobjects.render.prompt.OutputFormatSpec" in src, src)
            assertTrue("import com.metaobjects.render.prompt.PromptOverrides" in src, src)
            assertTrue("import com.metaobjects.render.prompt.PromptStyle" in src, src)
            assertTrue("import com.metaobjects.render.recover.FieldKind" in src, src)
            assertTrue("import com.metaobjects.render.recover.Format" in src, src)

            // Format.JSON in SPEC literal
            assertTrue("Format.JSON" in src, "expected Format.JSON in SPEC; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 3. XML format emits prompt with Format.XML.
    // ---------------------------------------------------------------------------
    @Test fun xmlFormatEmitsPromptWithFormatXml() {
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

        val outDir = Files.createTempDirectory("kprompt-xml-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-xml-prompt", fx))

            val promptFile = outDir.resolve("acme/reports/prompts/SummaryPrompt.kt")
            assertTrue(Files.exists(promptFile),
                "expected SummaryPrompt.kt; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(promptFile)

            assertTrue("object SummaryPrompt" in src, "missing object SummaryPrompt; src:\n$src")
            assertTrue("Format.XML" in src, "expected Format.XML for xml format; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 4. Text format (default) → no file emitted (no-op).
    // ---------------------------------------------------------------------------
    @Test fun textFormatEmitsNoFile() {
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

        val outDir = Files.createTempDirectory("kprompt-text-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-text-noprompt", fx))

            val emitted = Files.walk(outDir).filter { Files.isRegularFile(it) }.toList()
            assertEquals(0, emitted.size,
                "text format must NOT emit any prompt file; got: $emitted")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 5. No @format (defaults to text) → no file emitted.
    // ---------------------------------------------------------------------------
    @Test fun noFormatAttrDefaultsToTextAndNoEmit() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "demo/reply" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kprompt-noformat-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-noformat-noprompt", fx))

            val emitted = Files.walk(outDir).filter { Files.isRegularFile(it) }.toList()
            assertEquals(0, emitted.size,
                "absent @format (defaults to text) must not emit any prompt file; got: $emitted")
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

        val outDir = Files.createTempDirectory("kprompt-promptonly-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-promptonly", fx))

            val emitted = Files.walk(outDir).filter { Files.isRegularFile(it) }.toList()
            assertEquals(0, emitted.size,
                "expected zero files for a prompt-only fixture; got: $emitted")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 7. Multiple template.outputs → one prompt file per json/xml output.
    // ---------------------------------------------------------------------------
    @Test fun emitsOneFilePerJsonXmlTemplateOutput() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "Greeting", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "object.value": { "name": "Farewell", "children": [
                { "field.string": { "name": "text" } }
            ] } },
            { "template.output": { "name": "Reply",
                "@payloadRef": "Greeting", "@textRef": "ai/reply",
                "@format": "json" } },
            { "template.output": { "name": "Goodbye",
                "@payloadRef": "Farewell", "@textRef": "ai/goodbye",
                "@format": "xml" } },
            { "template.output": { "name": "Note",
                "@payloadRef": "Greeting", "@textRef": "ai/note",
                "@format": "text" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kprompt-multi-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-multi-prompt", fx))

            // json + xml → prompt files
            assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/ReplyPrompt.kt")),
                "expected ReplyPrompt.kt for json format")
            assertTrue(Files.exists(outDir.resolve("acme/ai/prompts/GoodbyePrompt.kt")),
                "expected GoodbyePrompt.kt for xml format")

            // text → no file
            assertFalse(Files.exists(outDir.resolve("acme/ai/prompts/NotePrompt.kt")),
                "text format must NOT emit a prompt file")

            val reply = Files.readString(outDir.resolve("acme/ai/prompts/ReplyPrompt.kt"))
            val goodbye = Files.readString(outDir.resolve("acme/ai/prompts/GoodbyePrompt.kt"))

            assertTrue("object ReplyPrompt" in reply, reply)
            assertTrue("Format.JSON" in reply, reply)
            assertTrue("object GoodbyePrompt" in goodbye, goodbye)
            assertTrue("Format.XML" in goodbye, goodbye)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 8. PromptStyle from @promptStyle attr is reflected in SPEC literal.
    // ---------------------------------------------------------------------------
    @Test fun promptStyleAttrReflectedInSpec() {
        val fx = """{
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "StylePayload", "children": [
                { "field.string": { "name": "x" } }
            ] } },
            { "template.output": { "name": "StyleTemplate",
                "@payloadRef": "StylePayload",
                "@textRef": "ai/style",
                "@format": "json",
                "@promptStyle": "inline" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kprompt-style-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-style-prompt", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/StyleTemplatePrompt.kt"))
            assertTrue("PromptStyle.INLINE" in src,
                "expected PromptStyle.INLINE for @promptStyle:inline; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 9. SPEC rootName is the payload class name (templateShort + "Payload").
    // ---------------------------------------------------------------------------
    @Test fun specRootNameIsPayloadClassName() {
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

        val outDir = Files.createTempDirectory("kprompt-rootname-")
        try {
            val gen = KotlinOutputPromptGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test-rootname-prompt", fx))

            val src = Files.readString(outDir.resolve("acme/ai/prompts/AnswerPrompt.kt"))
            // SPEC rootName = templateShort + "Payload" = "AnswerPayload"
            assertTrue("\"AnswerPayload\"" in src,
                "SPEC rootName must be the payload class name 'AnswerPayload'; src:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
