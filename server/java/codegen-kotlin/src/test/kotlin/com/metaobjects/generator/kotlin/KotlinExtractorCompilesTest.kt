package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.lang.reflect.InvocationTargetException
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Cross-port Extractor codegen (Kotlin port) — compile-and-run proof for [KotlinExtractorGenerator].
 *
 * Mirrors [KotlinOutputCompilesTest]: generate Payload + Parser + Extractor into a temp dir,
 * compile all together with `KotlinCompilation(inheritClassPath=true)`, then reflectively invoke.
 *
 * The fixture exercises the full nested type graph the extractor must map mirror->strict:
 *  - REQUIRED single nested object (customer -> Customer{name})
 *  - REQUIRED array-of-objects (lines -> Line{sku, qty})
 *  - REQUIRED string scalar-array (tags: List<String>)
 *  - REQUIRED int scalar-array (scores: List<Int>) — proves non-string scalar arrays (the C# bug)
 *  - OPTIONAL scalar (note: String)
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExtractorCompilesTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.value": { "name": "Customer", "children": [
            { "field.string": { "name": "name", "@required": true } }
        ] } },
        { "object.value": { "name": "Line", "children": [
            { "field.string": { "name": "sku", "@required": true } },
            { "field.int":    { "name": "qty", "@required": true } }
        ] } },
        { "object.value": { "name": "Order", "children": [
            { "field.object":   { "name": "customer", "@objectRef": "acme::shop::Customer", "@required": true } },
            { "field.object":   { "name": "lines", "@objectRef": "acme::shop::Line", "isArray": true, "@required": true } },
            { "field.string":   { "name": "tags", "isArray": true, "@required": true } },
            { "field.int":      { "name": "scores", "isArray": true, "@required": true } },
            { "field.string":   { "name": "note" } }
        ] } },
        { "template.output": { "name": "OrderOut",
            "@payloadRef": "Order",
            "@textRef": "shop/order",
            "@format": "json",
            "@promptStyle": "guide" } }
      ] }
    }""".trimIndent()

    @Test fun `extract maps the recovered mirror onto the strict payload`() {
        val outDir = Files.createTempDirectory("compile-extractor-")
        try {
            val loader = loadString("extractor-test", fixture)

            for (gen in listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }

            val compilation = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }
            val compileResult = compilation.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "Extractor generated Kotlin failed to compile:\n${compileResult.messages}")

            val cl = compileResult.classLoader

            val extractorClass = cl.loadClass("acme.shop.prompts.OrderOutExtractor")
            assertNotNull(extractorClass, "OrderExtractor class must be loadable")
            val extractorInstance = extractorClass.getDeclaredField("INSTANCE").get(null)

            val loaderClass = cl.loadClass("com.metaobjects.loader.MetaDataLoader")
            val extractMethod = extractorClass.getDeclaredMethod("extract", loaderClass, String::class.java)

            // ---- happy path: dirty text (preamble + fenced json + trailing comma) ----
            val dirty = "Sure, here it is!\n```json\n" +
                "{\"customer\":{\"name\":\"Ada\"}," +
                "\"lines\":[{\"sku\":\"A\",\"qty\":1},{\"sku\":\"B\",\"qty\":2}]," +
                "\"tags\":[\"x\",\"y\"]," +
                "\"scores\":[3,7]," +
                "\"note\":\"hi\",}\n```"

            val order = extractMethod.invoke(extractorInstance, loader, dirty)
            assertNotNull(order, "extract must return a strict Order payload")

            val orderClass = cl.loadClass("acme.shop.prompts.OrderOutPayload")
            val customer = orderClass.getDeclaredMethod("getCustomer").invoke(order)
            val customerClass = cl.loadClass("acme.shop.prompts.CustomerPayload")
            assertEquals("Ada", customerClass.getDeclaredMethod("getName").invoke(customer),
                "nested customer.name must populate")

            val lines = orderClass.getDeclaredMethod("getLines").invoke(order) as List<*>
            assertEquals(2, lines.size, "lines array must have 2 elements")
            val lineClass = cl.loadClass("acme.shop.prompts.LinePayload")
            assertEquals("A", lineClass.getDeclaredMethod("getSku").invoke(lines[0]),
                "lines[0].sku must populate")
            assertEquals(2, lineClass.getDeclaredMethod("getQty").invoke(lines[1]),
                "lines[1].qty must populate (typed Int)")

            @Suppress("UNCHECKED_CAST")
            val tags = orderClass.getDeclaredMethod("getTags").invoke(order) as List<String>
            assertEquals(listOf("x", "y"), tags, "string scalar-array must populate")

            @Suppress("UNCHECKED_CAST")
            val scores = orderClass.getDeclaredMethod("getScores").invoke(order) as List<Int>
            assertEquals(listOf(3, 7), scores, "int scalar-array must populate as typed List<Int>")

            assertEquals("hi", orderClass.getDeclaredMethod("getNote").invoke(order),
                "optional scalar note must populate")

            // ---- lost-required path: missing required customer -> throws ----
            try {
                extractMethod.invoke(extractorInstance, loader, "{ \"lines\": [] }")
                fail("extract must throw when a required field is lost")
            } catch (e: InvocationTargetException) {
                assertTrue(e.cause is RuntimeException,
                    "unwrapped cause must be a RuntimeException (RecoverException); got ${e.cause}")
            }

            // ---- re-exposed recover(loader, clean): never throws, no lost-required ----
            val recoverMethod = extractorClass.getDeclaredMethod("recover", loaderClass, String::class.java)
            val clean = "{\"customer\":{\"name\":\"Ada\"}," +
                "\"lines\":[{\"sku\":\"A\",\"qty\":1}]," +
                "\"tags\":[\"x\"],\"scores\":[3],\"note\":\"hi\"}"
            val rr = recoverMethod.invoke(extractorInstance, loader, clean)
            val reportClass = cl.loadClass("com.metaobjects.render.recover.RecoveryReport")
            val report = rr.javaClass.getMethod("report").invoke(rr)
            assertFalse(reportClass.getDeclaredMethod("hasLostRequired").invoke(report) as Boolean,
                "clean input must have hasLostRequired() == false")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
