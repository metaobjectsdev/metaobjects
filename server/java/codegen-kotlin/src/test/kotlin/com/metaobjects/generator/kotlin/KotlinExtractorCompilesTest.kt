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
 *  - REQUIRED float scalar-array (ratings: List<Float>) — proves a non-Int numeric element parse
 *  - REQUIRED long scalar-array (counts: List<Long>) — proves the Long element parse (it.toLong())
 *  - REQUIRED double scalar-array (weights: List<Double>) — proves the Double element parse
 *  - REQUIRED bool scalar-array (active: List<Boolean>) — proves the Boolean element parse
 *  - REQUIRED enum scalar-array (flags: List<String>) — proves the enum element type passthrough
 *  - OPTIONAL scalar (note: String)
 *
 * The generated extractor source is additionally compiled with warnings-as-errors (see the
 * extractor-source `allWarningsAsErrors` compile below) so an "Unnecessary non-null assertion"
 * warning (e.g. a stray `it!!` on the array-of-objects element) is a hard failure.
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
            { "field.float":    { "name": "ratings", "isArray": true, "@required": true } },
            { "field.long":     { "name": "counts", "isArray": true, "@required": true } },
            { "field.double":   { "name": "weights", "isArray": true, "@required": true } },
            { "field.boolean":  { "name": "active", "isArray": true, "@required": true } },
            { "field.enum":     { "name": "flags", "isArray": true, "@required": true, "@values": ["A", "B"] } },
            { "field.enum":     { "name": "priority", "@required": true, "@values": ["LOW", "HIGH"] } },
            { "field.enum":     { "name": "labels", "isArray": true, "@required": true, "@values": ["A", "B"] } },
            { "field.string":   { "name": "note" } }
        ] } },
        { "template.output": { "name": "OrderOut",
            "@payloadRef": "Order",
            "@textRef": "shop/order",
            "@format": "json",
            "@promptStyle": "guide" } }
      ] }
    }""".trimIndent()

    @Test fun `extract maps the extracted mirror onto the strict payload`() {
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
                "\"ratings\":[1.5,2.5]," +
                "\"counts\":[10,20]," +
                "\"weights\":[1.25,2.75]," +
                "\"active\":[true,false]," +
                "\"flags\":[\"A\",\"B\"]," +
                "\"priority\":\"HIGH\"," +
                "\"labels\":[\"A\",\"B\"]," +
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

            @Suppress("UNCHECKED_CAST")
            val ratings = orderClass.getDeclaredMethod("getRatings").invoke(order) as List<Float>
            assertEquals(listOf(1.5f, 2.5f), ratings,
                "float scalar-array must populate as typed List<Float> (non-Int numeric element parse)")

            @Suppress("UNCHECKED_CAST")
            val counts = orderClass.getDeclaredMethod("getCounts").invoke(order) as List<Long>
            assertEquals(listOf(10L, 20L), counts,
                "long scalar-array must populate as typed List<Long> (it.toLong() element parse)")
            counts.forEach { assertTrue(it is Long, "counts element must be a boxed Long, got ${it!!::class}") }

            @Suppress("UNCHECKED_CAST")
            val weights = orderClass.getDeclaredMethod("getWeights").invoke(order) as List<Double>
            assertEquals(listOf(1.25, 2.75), weights,
                "double scalar-array must populate as typed List<Double> (it.toDouble() element parse)")
            weights.forEach { assertTrue(it is Double, "weights element must be a boxed Double, got ${it!!::class}") }

            @Suppress("UNCHECKED_CAST")
            val active = orderClass.getDeclaredMethod("getActive").invoke(order) as List<Boolean>
            assertEquals(listOf(true, false), active,
                "boolean scalar-array must populate as typed List<Boolean> (it.toBoolean() element parse)")
            active.forEach { assertTrue(it is Boolean, "active element must be a boxed Boolean, got ${it!!::class}") }

            @Suppress("UNCHECKED_CAST")
            val flags = orderClass.getDeclaredMethod("getFlags").invoke(order) as List<Any>
            val flagsElemType = cl.loadClass("acme.shop.OrderFlags")
            assertTrue(flagsElemType.isEnum, "OrderFlags must be a generated enum class")
            assertEquals(listOf("A", "B"), flags.map { (it as Enum<*>).name },
                "enum scalar-array must populate as typed List<OrderFlags> (per-element valueOf)")

            // ---- typed enum (single): strict property is the generated enum class OrderPriority ----
            val priority = orderClass.getDeclaredMethod("getPriority").invoke(order)
            val priorityType = orderClass.getDeclaredMethod("getPriority").returnType
            assertTrue(priorityType.isEnum,
                "strict priority must be a generated enum class, not String; was $priorityType")
            assertEquals("OrderPriority", priorityType.simpleName,
                "enum class must be named <EntityShort><FieldPascal> = OrderPriority")
            assertEquals("HIGH", (priority as Enum<*>).name,
                "priority must coerce to OrderPriority.HIGH via valueOf")

            // ---- typed enum ARRAY: List<OrderLabels>, members ["A","B"], per-element valueOf ----
            @Suppress("UNCHECKED_CAST")
            val labels = orderClass.getDeclaredMethod("getLabels").invoke(order) as List<Any>
            val labelsElemType = cl.loadClass("acme.shop.OrderLabels")
            assertTrue(labelsElemType.isEnum, "OrderLabels must be a generated enum class")
            assertEquals(listOf("A", "B"), labelsElemType.enumConstants.map { (it as Enum<*>).name },
                "OrderLabels members must be [A, B] verbatim")
            assertEquals(2, labels.size, "labels array must have 2 elements")
            assertTrue(labels.all { labelsElemType.isInstance(it) },
                "every labels element must be an OrderLabels enum instance")
            assertEquals(listOf("A", "B"), labels.map { (it as Enum<*>).name },
                "labels must coerce element-wise via OrderLabels.valueOf")

            assertEquals("hi", orderClass.getDeclaredMethod("getNote").invoke(order),
                "optional scalar note must populate")

            // ---- lenient mirror leaf STAYS String / List<String?> (only strict changes) ----
            val mirrorClass = cl.loadClass("acme.shop.prompts.OrderOutExtracted")
            assertEquals(String::class.java, mirrorClass.getDeclaredMethod("getPriority").returnType,
                "lenient mirror priority must stay String (only the strict payload is enum-typed)")
            assertTrue(List::class.java.isAssignableFrom(mirrorClass.getDeclaredMethod("getLabels").returnType),
                "lenient mirror labels must stay a List<String?> (not List<enum>)")

            // ---- lost-required path: missing required customer -> throws ----
            try {
                extractMethod.invoke(extractorInstance, loader, "{ \"lines\": [] }")
                fail("extract must throw when a required field is lost")
            } catch (e: InvocationTargetException) {
                assertTrue(e.cause is RuntimeException,
                    "unwrapped cause must be a RuntimeException (ExtractException); got ${e.cause}")
            }

            // ---- re-exposed extractLenient(loader, clean): never throws, no lost-required ----
            val extractLenientMethod = extractorClass.getDeclaredMethod("extractLenient", loaderClass, String::class.java)
            val clean = "{\"customer\":{\"name\":\"Ada\"}," +
                "\"lines\":[{\"sku\":\"A\",\"qty\":1}]," +
                "\"tags\":[\"x\"],\"scores\":[3],\"ratings\":[1.5]," +
                "\"counts\":[10],\"weights\":[1.25],\"active\":[true],\"flags\":[\"A\"]," +
                "\"priority\":\"LOW\",\"labels\":[\"A\"],\"note\":\"hi\"}"
            val rr = extractLenientMethod.invoke(extractorInstance, loader, clean)
            val reportClass = cl.loadClass("com.metaobjects.render.extract.ExtractionReport")
            val report = rr.javaClass.getMethod("report").invoke(rr)
            assertFalse(reportClass.getDeclaredMethod("hasLostRequired").invoke(report) as Boolean,
                "clean input must have hasLostRequired() == false")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Lock in I1: the generated extractor must compile warning-free under warnings-as-errors so a
     * stray "Unnecessary non-null assertion" (e.g. a per-element `it!!` on the array-of-objects map)
     * cannot regress for `-Werror` consumers.
     *
     * Approach: compile the FULL generated set (Payload + Parser + Extractor) with
     * `allWarningsAsErrors = true`. If the build is clean this is the strongest gate. If
     * pre-existing warnings in the payload/parser (which this fix does not own) trip the global
     * flag, fall back to asserting specifically that the extractor produced no "Unnecessary non-null
     * assertion" warning — and report which path was taken via the failure message.
     */
    @Test fun `generated extractor compiles warning-free (no unnecessary non-null assertion)`() {
        val outDir = Files.createTempDirectory("compile-extractor-werror-")
        try {
            val loader = loadString("extractor-werror-test", fixture)
            for (gen in listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }

            val werror = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                allWarningsAsErrors = true
                messageOutputStream = System.out
            }
            val result = werror.compile()

            // No "Unnecessary non-null assertion" anywhere in the generated set — the direct I1 gate.
            assertFalse(
                result.messages.contains("Unnecessary non-null assertion"),
                "generated extractor must not emit an 'Unnecessary non-null assertion' warning:\n${result.messages}"
            )

            // Strongest form: the whole generated set is warning-clean under -Werror. If this trips
            // on a pre-existing payload/parser warning we don't own, the assertion above already
            // proved I1; surface the messages so the offending (non-extractor) warning is visible.
            assertEquals(
                KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated set failed under allWarningsAsErrors (I1's no-non-null-assertion gate already " +
                    "passed; remaining warnings are not owned by this fix):\n${result.messages}"
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Shared-enum dedup proof: an abstract `field.enum Priority @values ["LOW","HIGH"]` plus two
     * fields that `extends` it must emit EXACTLY ONE `enum class Priority` (named for the super,
     * deduped by FQN), with BOTH strict-payload fields typed `Priority`. The lenient mirror leaves
     * them String. Compile + reflect to prove the single shared enum class.
     */
    private val sharedEnumFixture = """{
      "metadata.root": { "package": "acme::orders", "children": [
        { "field.enum": { "name": "Priority", "abstract": true, "@values": ["LOW", "HIGH"] } },
        { "object.value": { "name": "Ticket", "children": [
            { "field.string": { "name": "ticketId", "@required": true } },
            { "field.enum":   { "name": "currentPriority",  "@required": true, "extends": "Priority" } },
            { "field.enum":   { "name": "previousPriority", "@required": true, "extends": "Priority" } }
        ] } },
        { "template.output": { "name": "TicketOut",
            "@payloadRef": "Ticket",
            "@textRef": "orders/ticket",
            "@format": "json",
            "@promptStyle": "guide" } }
      ] }
    }""".trimIndent()

    @Test fun `shared abstract field-enum emits one enum class named for the super, both fields typed by it`() {
        val outDir = Files.createTempDirectory("compile-extractor-sharedenum-")
        try {
            val loader = loadString("shared-enum-test", sharedEnumFixture)

            for (gen in listOf(KotlinPayloadGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // Exactly ONE Priority enum file emitted (deduped by FQN across the two fields).
            val priorityFiles = Files.walk(outDir)
                .filter { it.isRegularFile() && it.fileName.toString() == "Priority.kt" }
                .toList()
            assertEquals(1, priorityFiles.size,
                "exactly one Priority enum file must be emitted (deduped by super FQN); got " +
                    priorityFiles.map { it.toString() })
            assertTrue(priorityFiles[0].readText().contains("enum class Priority"),
                "emitted file must declare `enum class Priority`")

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "shared-enum generated Kotlin failed to compile:\n${result.messages}")

            val cl = result.classLoader
            val ticketPayload = cl.loadClass("acme.orders.prompts.TicketOutPayload")
            val priorityEnum = cl.loadClass("acme.orders.Priority")
            assertTrue(priorityEnum.isEnum, "Priority must be a generated enum class")
            assertEquals(listOf("LOW", "HIGH"), priorityEnum.enumConstants.map { (it as Enum<*>).name },
                "Priority members must be [LOW, HIGH] verbatim")

            // Both strict fields typed by the SAME shared enum class.
            assertEquals(priorityEnum, ticketPayload.getDeclaredMethod("getCurrentPriority").returnType,
                "currentPriority must be typed Priority (the shared super enum)")
            assertEquals(priorityEnum, ticketPayload.getDeclaredMethod("getPreviousPriority").returnType,
                "previousPriority must be typed by the SAME Priority enum (shared)")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
