package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.render.extract.ExtractOptions
import com.metaobjects.render.extract.ExtractionResult
import com.metaobjects.render.extract.Format
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #364 codegen pass-through proof — the Kotlin [KotlinOutputParserGenerator] emits
 * `extractLenient(loader, text, opts)` with `opts: ExtractOptions` untouched (it delegates
 * straight to the shared Java engine, [com.metaobjects.object.extract.MetaObjectExtractor]),
 * so the document-level `onLocate` hook must reach the engine THROUGH the generated,
 * kotlinc-compiled parser — not just the hand-called `com.metaobjects.render.extract.Extract`
 * engine proven directly in `OnLocateKotlinInteropTest`. Mirrors
 * [KotlinNestedExtractLenientCompileRunTest]'s generate → compile → classload → invoke
 * harness, reusing the same fixture.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinOnLocateCompileRunTest {

    private val nestedFixture = """{
      "metadata.root": { "package": "acme::ai", "children": [
        { "object.value": { "name": "AddressPayload", "children": [
            { "field.string": { "name": "city" } },
            { "field.string": { "name": "zip" } }
        ] } },
        { "object.value": { "name": "LineItemPayload", "children": [
            { "field.string": { "name": "sku" } },
            { "field.int":    { "name": "qty" } }
        ] } },
        { "object.value": { "name": "NestedAnswerPayload", "children": [
            { "field.string": { "name": "title", "@required": true } },
            { "field.object": { "name": "address", "@objectRef": "acme::ai::AddressPayload" } },
            { "field.object": { "name": "items", "@objectRef": "acme::ai::LineItemPayload",
                                "isArray": true } }
        ] } },
        { "template.prompt": {
            "name": "NestedAnswer",
            "@payloadRef": "NestedAnswerPayload", "@responseRef": "NestedAnswerPayload",
            "@textRef": "ai/nested",
            "@format": "text", "@responseFormat": "json" } }
      ] }
    }""".trimIndent()

    @Test fun `generated extractLenient threads opts onLocate to the engine`() {
        val outDir = Files.createTempDirectory("compile-onlocate-")
        try {
            val loader = loadString("onlocate-cr", nestedFixture)

            for (gen in listOf(KotlinEntityGenerator(), KotlinOutputParserGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            assertTrue(emitted.isNotEmpty(), "expected a generated parser file")

            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }

            val compileResult = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "onLocate generated Kotlin failed to compile:\n${compileResult.messages}")

            val cl = compileResult.classLoader
            val parserClass = cl.loadClass("acme.ai.prompts.NestedAnswerParser")
            val parserInstance = parserClass.getDeclaredField("INSTANCE").get(null)

            val extractLenientMethod = parserClass.getDeclaredMethod(
                "extractLenient",
                com.metaobjects.loader.MetaDataLoader::class.java,
                String::class.java,
                ExtractOptions::class.java
            )

            // The default locator would pick the FIRST fenced block (it carries the declared
            // `title` field, #363). onLocate picks the SECOND one instead, proving the option
            // flowed all the way through generated Kotlin code into the shared Java engine.
            val draft = """{"title":"DRAFT"}"""
            val real = """{"title":"Order #7","address":{"city":"Austin","zip":"78701"},"items":[{"sku":"A1","qty":2}]}"""
            val dirty = "```json\n$draft\n```\nOn second thought:\n```json\n$real\n```"

            val onLocate = ExtractOptions.OnLocate { text, format ->
                assertEquals(Format.JSON, format)
                Regex("```json\\s*\\n([\\s\\S]*?)\\n```").findAll(text).lastOrNull()?.groupValues?.get(1)
            }
            val opts = ExtractOptions.defaults().withOnLocate(onLocate)

            val result = extractLenientMethod.invoke(parserInstance, loader, dirty, opts) as ExtractionResult<*>

            val payload = result.data
            val title = payload!!.javaClass.getMethod("getTitle").invoke(payload)
            assertEquals("Order #7", title, "onLocate's chosen block must win over the default locator's choice")

            val sawOnLocate = result.report.coercions().any { it.kind() == "onLocate" }
            assertTrue(sawOnLocate,
                "report must carry an onLocate coercion entry when the generated parser is given opts.onLocate")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
