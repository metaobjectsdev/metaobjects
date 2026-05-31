package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.render.extract.ExtractionResult
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinOutputCompilesTest {

    private val entityFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100, "@required": true } }
        ] } }
      ] }
    }""".trimIndent()

    // FR-010 fixture: VO with string@required@example + enum with @enumAlias/@enumDoc + string
    // + a template.output @format:json @promptStyle:guide
    private val fr010Fixture = """{
      "metadata.root": { "package": "acme::ai", "children": [
        { "object.value": { "name": "OpinionOutputPayload", "children": [
            { "field.string": { "name": "text",
                "@required": true,
                "@example": "A well-reasoned response." } },
            { "field.enum": { "name": "confidence",
                "@required": true,
                "@values": ["HIGH", "OK", "LOW"],
                "@enumAlias": { "medium": "OK" },
                "@enumDoc": { "HIGH": "Very confident", "OK": "Reasonably confident", "LOW": "Best guess" } } },
            { "field.enum": { "name": "priority",
                "@required": true,
                "@values": ["HIGH", "OK", "LOW"],
                "@normalize": "none",
                "@coerceDefault": "LOW" } },
            { "field.string": { "name": "note" } }
        ] } },
        { "template.output": { "name": "Opinion",
            "@payloadRef": "OpinionOutputPayload",
            "@textRef": "ai/opinion",
            "@format": "json",
            "@promptStyle": "guide" } }
      ] }
    }""".trimIndent()

    @Test fun `generated Author kt compiles`() {
        val outDir = Files.createTempDirectory("compile-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", entityFixture))

            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
                .toList()

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true   // include kotlinx.serialization-runtime + Exposed if on the test classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated Kotlin failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * FR-010 compile-proof: generates OpinionPayload.kt (KotlinPayloadGenerator),
     * OpinionParser.kt with extractLenient() + EXTRACT_SCHEMA + OpinionExtracted
     * (KotlinOutputParserGenerator), and OpinionPrompt.kt with renderFormat()
     * (KotlinOutputPromptGenerator), then compiles all three together and
     * behaviorally exercises extractLenient() and renderFormat() via reflection.
     *
     * Behavioral assertions:
     *  - extractLenient("...{\"text\":\"hi\",\"confidence\":\"medium\"}...").data.confidence == "OK"
     *    (alias medium→OK fires)
     *  - extractLenient(...).data.text == "hi"
     *  - extractLenient(...).report.hasLostRequired() == false
     *  - renderFormat() returns a non-empty string with no HTML comments (<!)
     */
    @Test fun `FR-010 extract and renderFormat compile and run`() {
        val outDir = Files.createTempDirectory("compile-fr010-")
        try {
            val loader = loadString("fr010-test", fr010Fixture)

            // Run all three generators into the same output dir.
            for (gen in listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator(), KotlinOutputPromptGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // Collect all emitted .kt files — expect 3: OpinionPayload, OpinionParser, OpinionPrompt.
            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            assertEquals(3, emitted.size,
                "expected 3 generated files; got: ${emitted.map { it.fileName }}")

            // Name sources with unique keys (the parser + payload share no class names, but kotlin-compile-testing
            // requires uniquely named SourceFile entries).
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }

            val compilation = KotlinCompilation().apply {
                this.sources = sources
                // inheritClassPath = true brings metaobjects-render, kotlinx-serialization-json-jvm,
                // and kotlinx-serialization-core-jvm onto the compile classpath so that
                // the render engine types and Json class resolve.
                inheritClassPath = true
                messageOutputStream = System.out
            }
            val compileResult = compilation.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "FR-010 generated Kotlin failed to compile:\n${compileResult.messages}")

            // ----------------------------------------------------------------
            // Behavioral proof — load the compiled classes and invoke them.
            // ----------------------------------------------------------------
            val cl = compileResult.classLoader

            // --- extractLenient() ---
            val parserClass = cl.loadClass("acme.ai.prompts.OpinionParser")
            assertNotNull(parserClass, "OpinionParser class must be loadable")

            // The object's singleton instance is in the INSTANCE field (Kotlin object companion).
            val parserInstance = parserClass.getDeclaredField("INSTANCE").get(null)

            val extractLenientMethod = parserClass.getDeclaredMethod("extractLenient", String::class.java)
            @Suppress("UNCHECKED_CAST")
            val extractionResult = extractLenientMethod.invoke(parserInstance,
                "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"medium\",\"priority\":\"banana\"}\n```"
            ) as ExtractionResult<*>

            // data: OpinionExtracted — access fields via Kotlin data class properties (getters).
            val extracted = extractionResult.data
            assertNotNull(extracted, "ExtractionResult.data must not be null")

            val extractedClass = cl.loadClass("acme.ai.prompts.OpinionExtracted")
            val confidenceGetter = extractedClass.getDeclaredMethod("getConfidence")
            val textGetter = extractedClass.getDeclaredMethod("getText")
            val priorityGetter = extractedClass.getDeclaredMethod("getPriority")

            val confidenceVal = confidenceGetter.invoke(extracted)
            val textVal = textGetter.invoke(extracted)
            val priorityVal = priorityGetter.invoke(extracted)

            assertEquals("OK", confidenceVal,
                "alias medium→OK must fire: expected confidence=OK, got $confidenceVal")
            assertEquals("hi", textVal,
                "text field must be extracted as 'hi', got $textVal")
            // FR-011: off-vocab priority="banana" folds to @coerceDefault "LOW".
            assertEquals("LOW", priorityVal,
                "FR-011 @coerceDefault must fold off-vocab 'banana' to LOW, got $priorityVal")

            val report = extractionResult.report
            assertFalse(report.hasLostRequired(),
                "no required fields were absent so hasLostRequired() must be false; lost=${report.lostRequired()}")
            // FR-011: priority classifies DEFAULTED (reached via @coerceDefault).
            assertEquals("DEFAULTED", report.states()["priority"]?.toString(),
                "priority must classify DEFAULTED; states=${report.states()}")

            // --- renderFormat() ---
            val promptClass = cl.loadClass("acme.ai.prompts.OpinionPrompt")
            assertNotNull(promptClass, "OpinionPrompt class must be loadable")

            val promptInstance = promptClass.getDeclaredField("INSTANCE").get(null)
            val renderFormatMethod = promptClass.getDeclaredMethod("renderFormat")
            val fragment = renderFormatMethod.invoke(promptInstance) as String

            assertTrue(fragment.isNotEmpty(),
                "renderFormat() must return a non-empty string")
            assertFalse("<!--" in fragment,
                "renderFormat() must not contain HTML comments; got:\n$fragment")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
