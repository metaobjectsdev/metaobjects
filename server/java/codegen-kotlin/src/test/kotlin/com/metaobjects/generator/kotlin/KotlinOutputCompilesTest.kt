package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.render.extract.ExtractOptions
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

    // FR-017 TPH regression guard: a subtype's OWN field.enum (CopayAuth.tier) folds into the base
    // Auth union data class, so the base must emit that enum class (owner = base) — else the union
    // references a type no generated file defines. The subtypes themselves emit nothing.
    private val tphSubtypeEnumFixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.enum": { "name": "tier", "@values": ["Standard", "Premium"] } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `FR-017 TPH base union with a folded subtype enum compiles`() {
        val outDir = Files.createTempDirectory("compile-tph-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("tph-test", tphSubtypeEnumFixture))

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val names = emitted.map { it.fileName.toString() }.toSet()
            // The base emits the union + the discriminator enum + the folded subtype enum; the
            // subtypes emit NO entity data class or enum of their own (they fold into the base).
            assertTrue("AuthTier.kt" in names,
                "the folded subtype enum (CopayAuth.tier) must be emitted by the base; got $names")
            assertFalse("BridgeAuth.kt" in names || "CopayAuth.kt" in names,
                "TPH subtypes must emit no entity data class of their own; got $names")
            assertFalse("BridgeAuthTier.kt" in names || "CopayAuthTier.kt" in names,
                "a subtype must not re-emit a folded enum under its own name; got $names")
            // FR-036: each concrete subtype DOES emit a validation-only <Sub>Validation shape (the
            // base controller validates per-subtype POST/PATCH present values against it) — BridgeAuth
            // has a @required `quantity`, CopayAuth an unconstrained enum `tier`.
            assertTrue("BridgeAuthValidation.kt" in names && "CopayAuthValidation.kt" in names,
                "each concrete TPH subtype must emit its annotated <Sub>Validation shape; got $names")

            val result = KotlinCompilation().apply {
                this.sources = emitted.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "TPH union with a folded subtype enum failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

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
     * OpinionParser.kt with the loader-delegating extractLenient(loader, text) + OpinionExtracted
     * (KotlinOutputParserGenerator), and OpinionPrompt.kt with renderFormat()
     * (KotlinOutputPromptGenerator), then compiles all three together and
     * behaviorally exercises extractLenient(loader, ...) and renderFormat() via reflection.
     *
     * Behavioral assertions (the extract delegates to MetaObjectExtractor, reading FR-011
     * coercion attrs directly off the live metadata):
     *  - extractLenient(loader, "...{\"text\":\"hi\",\"confidence\":\"medium\"}...").data.confidence == "OK"
     *    (alias medium→OK fires)
     *  - extractLenient(loader, ...).data.text == "hi"
     *  - extractLenient(loader, ...).report.hasLostRequired() == false
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

            // Collect all emitted .kt files — expect 5: OpinionPayload, OpinionParser, OpinionPrompt,
            // plus one typed enum-class file per `field.enum` payload field (confidence, priority).
            // The strict payload types those fields as the generated enum class (the lenient mirror
            // leaf stays String — asserted below), so the enum files must be emitted + compile.
            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            assertEquals(5, emitted.size,
                "expected 5 generated files (3 + 2 enum classes); got: ${emitted.map { it.fileName }}")
            val emittedNames = emitted.map { it.fileName.toString() }.toSet()
            assertTrue("OpinionOutputPayloadConfidence.kt" in emittedNames,
                "typed enum class for `confidence` must be emitted; got $emittedNames")
            assertTrue("OpinionOutputPayloadPriority.kt" in emittedNames,
                "typed enum class for `priority` must be emitted; got $emittedNames")

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

            // The single metadata-driven extract path: the loader-delegating overload
            // resolves the payload MetaObject from the live loader (built from fr010Fixture)
            // and delegates to MetaObjectExtractor — reading FR-011 coercion attrs directly
            // off the live metadata (alias medium→OK; @coerceDefault banana→LOW).
            val extractLenientMethod = parserClass.getDeclaredMethod(
                "extractLenient", MetaDataLoader::class.java, String::class.java, ExtractOptions::class.java
            )
            @Suppress("UNCHECKED_CAST")
            val extractionResult = extractLenientMethod.invoke(parserInstance,
                loader,
                "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"medium\",\"priority\":\"banana\"}\n```",
                ExtractOptions.defaults()
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
