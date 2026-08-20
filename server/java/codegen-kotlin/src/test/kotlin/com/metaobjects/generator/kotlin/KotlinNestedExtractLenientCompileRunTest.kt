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
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * FR-010 nested gap CLOSED for Kotlin — compile-AND-run gold-standard proof, mirroring
 * the Java pilot's `GeneratedNestedExtractLenientCompileRunTest`.
 *
 * <p>Generates the parser for a payload with a single nested object field AND an
 * array-of-objects field (the nested extracted mirrors are emitted into the same parser
 * file by [KotlinOutputParserGenerator] / [KotlinExtractSchemaEmitter]), COMPILES it,
 * loads the parser object, and invokes the runtime-delegating
 * `extractLenient(loader: MetaDataLoader, text: String)` on DIRTY nested JSON.</p>
 *
 * <p>Asserts the nested object AND the array-of-objects components are fully POPULATED
 * (NOT null) in the typed Extracted mirror. This is the codegen-wrapping-runtime pattern:
 * the generated parser resolves its payload MetaObject by FQN from the supplied loader,
 * delegates to [com.metaobjects.object.extract.MetaObjectExtractor] (which assembles the
 * full graph reflection-free), then maps the assembled ValueObject graph into the typed
 * Extracted-mirror graph via the generated `from<Extracted>(Map)` mappers.</p>
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinNestedExtractLenientCompileRunTest {

    // Payload: NestedAnswerPayload with
    //   title   (String, required)
    //   address (AddressPayload: city, zip)        — single nested object
    //   items   (List<LineItemPayload>: sku, qty)  — array-of-objects
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

    @Test fun `delegating extract populates nested object and array-of-objects`() {
        val outDir = Files.createTempDirectory("compile-nested-")
        try {
            val loader = loadString("nested-cr", nestedFixture)

            // The parser emits the root + nested Extracted mirrors itself (and the
            // runtime-delegating extract assembles the graph from the loader's MetaObject,
            // not the payload classes). The payload generator is also run so the parser's
            // parse()/safeParse() serialization surface (which references <X>Payload + its
            // nested payload classes) compiles alongside.
            for (gen in listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator())) {
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
                inheritClassPath = true   // brings metaobjects-render + metaobjects-om + metadata onto the classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "nested-extract generated Kotlin failed to compile:\n${compileResult.messages}")

            // ----------------------------------------------------------------
            // Behavioral proof — invoke extractLenient(loader, dirtyJson) and assert the
            // nested object + array-of-objects are POPULATED (the closed gap).
            // ----------------------------------------------------------------
            val cl = compileResult.classLoader
            val parserClass = cl.loadClass("acme.ai.prompts.NestedAnswerParser")
            val parserInstance = parserClass.getDeclaredField("INSTANCE").get(null)

            val extractLenientMethod = parserClass.getDeclaredMethod(
                "extractLenient",
                com.metaobjects.loader.MetaDataLoader::class.java,
                String::class.java,
                com.metaobjects.render.extract.ExtractOptions::class.java
            )

            val dirty = "Here you go:\n```json\n" +
                "{\"title\":\"Order #7\"," +
                "\"address\":{\"city\":\"Austin\",\"zip\":\"78701\"}," +
                "\"items\":[{\"sku\":\"A1\",\"qty\":2},{\"sku\":\"B2\",\"qty\":5}]}" +
                "\n```\nThanks!"

            val result = extractLenientMethod.invoke(
                parserInstance, loader, dirty,
                com.metaobjects.render.extract.ExtractOptions.defaults()
            ) as ExtractionResult<*>

            val payload = result.data
            assertNotNull(payload, "extracted payload must not be null")

            // --- top-level scalar ---
            val title = payload.javaClass.getMethod("getTitle").invoke(payload)
            assertEquals("Order #7", title, "title component")

            // --- single nested object: address must NOT be null and must be populated ---
            val address = payload.javaClass.getMethod("getAddress").invoke(payload)
            assertNotNull(address, "address nested object must be populated (NOT null) — the closed gap")
            val city = address.javaClass.getMethod("getCity").invoke(address)
            val zip  = address.javaClass.getMethod("getZip").invoke(address)
            assertEquals("Austin", city, "address.city")
            assertEquals("78701", zip, "address.zip")

            // --- array-of-objects: items must be a populated List<LineItemExtracted> ---
            val items = payload.javaClass.getMethod("getItems").invoke(payload)
            assertNotNull(items, "items array-of-objects must be populated (NOT null) — the closed gap")
            assertTrue(items is List<*>, "items must be a List")
            val itemList = items as List<*>
            assertEquals(2, itemList.size, "items size")

            val item0 = itemList[0]!!
            val sku0 = item0.javaClass.getMethod("getSku").invoke(item0)
            val qty0 = item0.javaClass.getMethod("getQty").invoke(item0)
            assertEquals("A1", sku0, "items[0].sku")
            assertEquals(2, qty0, "items[0].qty")

            val item1 = itemList[1]!!
            val sku1 = item1.javaClass.getMethod("getSku").invoke(item1)
            assertEquals("B2", sku1, "items[1].sku")

            // --- report: no required field lost (title extracted) ---
            val report = result.report
            val hasLostRequired = report.javaClass.getMethod("hasLostRequired").invoke(report) as Boolean
            assertTrue(!hasLostRequired, "hasLostRequired must be false — title extracted")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
