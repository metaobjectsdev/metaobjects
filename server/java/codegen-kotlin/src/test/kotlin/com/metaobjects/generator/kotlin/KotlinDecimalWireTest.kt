package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ADR-0019 Amendment 1, the decimal wire rule, as the Kotlin generators write it. The rule lives in
 * a generated, per-package `MetaDecimalWire.kt` that the entity, table and controller call, so the
 * generated code imports nothing from MetaObjects. What is pinned here is that file and WIRING it in: the property
 * annotations (W1/W2), the filter operand parser (W2), the unreadable-body handler (W2), the
 * PATCH bind (W2/W3), the SQLite read at 15 digits (W4) and the TPH allowlist admitting decimals.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinDecimalWireTest {

    private val model = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.entity": { "name": "Item", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 40 } },
            { "field.decimal": { "name": "price", "@precision": 12, "@scale": 2, "@filterable": true } },
            { "source.rdb": { "@table": "items" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private val tphModel = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.entity": { "name": "Charge", "@discriminator": "kind", "children": [
            { "source.rdb": { "@table": "charges" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "kind", "@values": ["Card", "Cash"] } },
            { "field.decimal": { "name": "amount", "@precision": 12, "@scale": 2, "@filterable": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "CardCharge", "extends": "Charge", "@discriminatorValue": "Card", "children": [
            { "field.decimal": { "name": "fee", "@precision": 12, "@scale": 2, "@filterable": true } }
        ] } }
      ] }
    }""".trimIndent()

    private fun emit(json: String, generators: List<Generator>): Map<String, String> {
        val outDir = Files.createTempDirectory("kt-decimal-wire-")
        try {
            val loader = loadString("decimal-wire", json)
            for (gen in generators) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val files = TreeMap<String, String>()
            Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.forEach { files[outDir.relativize(it).toString()] = it.readText() }
            }
            return files
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun all() = listOf<Generator>(
        KotlinEntityGenerator(), KotlinExposedTableGenerator(),
        KotlinFilterAllowlistGenerator(), KotlinSpringControllerGenerator(),
    )

    @Test
    fun `a decimal property writes a canonical string and reads a string or a number exactly`() {
        val src = emit(model, all()).getValue("acme/shop/Item.kt")
        assertTrue("@get:JsonSerialize(using = MetaDecimalWire.Serializer::class)" in src, src)
        assertTrue("@param:JsonDeserialize(using = MetaDecimalWire.Deserializer::class)" in src, src)
        // Only the decimal carries them.
        assertEquals(1, Regex("MetaDecimalWire.Serializer::class").findAll(src).count(), src)
    }

    @Test
    fun `a filter operand on a decimal goes through the canonical grammar, never a double`() {
        val src = emit(model, all()).getValue("acme/shop/ItemController.kt")
        assertTrue("MetaDecimalWire.parseFilterOperand" in src, src)
        assertFalse("runCatching { java.math.BigDecimal(s) }" in src, src)
    }

    @Test
    fun `a body that cannot be read is a 400 in the validation envelope naming the field`() {
        val src = emit(model, all()).getValue("acme/shop/ItemController.kt")
        assertTrue("@ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException::class)" in src, src)
        assertTrue("MetaDecimalWire.unreadableBody(e)" in src, src)
    }

    @Test
    fun `a PATCH decimal binds through the same reader as a create body and a bad one is a 400 naming the field`() {
        val src = emit(model, all()).getValue("acme/shop/ItemController.kt")
        assertTrue("MetaDecimalWire.fromNode(body.get(\"price\"))" in src, src)
        assertTrue("mapOf(\"error\" to \"validation\", \"field\" to \"price\")" in src, src)
    }

    @Test
    fun `SQLite reads a decimal at 15 significant digits`() {
        val src = emit(model, all()).getValue("acme/shop/MetaPortableColumnTypes.kt")
        assertTrue("MetaDecimalWire.fromDouble15(value.toDouble())" in src, src)
        assertTrue("isSqlite() && value is Number && value !is BigDecimal" in src, src)
    }

    @Test
    fun `a TPH base admits its decimal columns to the allowlist and the filter dispatch`() {
        val files = emit(tphModel, all())
        val allowlist = files.getValue("acme/shop/ChargeFilterAllowlist.kt")
        assertTrue("\"amount\"" in allowlist, allowlist)
        assertTrue("\"fee\"" in allowlist, allowlist)
        val controller = files.getValue("acme/shop/ChargeController.kt")
        assertTrue("import java.math.BigDecimal" in controller, controller)
        assertTrue("\"amount\" -> coerceChargeDecimal(op, raw)" in controller, controller)
    }

    @Test
    fun `a decimal beyond the declared precision and scale is a 400 on create and on PATCH, never rounded (W3)`() {
        val src = emit(model, all()).getValue("acme/shop/ItemController.kt")
        // @precision 12, @scale 2: at most 2 fraction digits and 10 integer digits.
        val fits = "MetaDecimalWire.fits(" ; val bounds = ", 12, 2)"
        assertEquals(2, Regex(Regex.escape(fits) + "[^\\n]*?" + Regex.escape(bounds)).findAll(src).count(), src)
        assertTrue("if (!MetaDecimalWire.fits(dto.price, 12, 2))" in src, src)
        assertTrue("if (!MetaDecimalWire.fits(vPrice, 12, 2))" in src, src)
        assertTrue("\"field\" to \"price\"" in src, src)
    }

    @Test
    fun `a TPH base and its subtype enforce the declared range on their per-subtype writes`() {
        val src = emit(tphModel, all()).getValue("acme/shop/ChargeController.kt")
        assertTrue("if (!MetaDecimalWire.fits(dto.fee, 12, 2))" in src, src)
        assertTrue("if (!MetaDecimalWire.fits(vFee, 12, 2))" in src, src)
    }

    @Test
    fun `no generated Kotlin source imports or names a MetaObjects package`() {
        for ((name, json) in listOf("item" to model, "tph" to tphModel)) {
            for ((path, src) in emit(json, all())) {
                if (!path.endsWith(".kt")) continue
                // Comments may name a MetaObjects document; code, imports and annotations may not.
                val code = src.lineSequence().filterNot { it.trimStart().let { l -> l.startsWith("*") || l.startsWith("/*") || l.startsWith("//") } }
                    .joinToString("\n")
                assertFalse("com.metaobjects." in code, "$name/$path references a MetaObjects package:\n$src")
            }
        }
    }

    @Test
    fun `the generated MetaDecimalWire compiles with no MetaObjects runtime and follows the wire rule`() {
        val files = emit(model, listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) ->
            com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
        }
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val wire = result.classLoader.loadClass("acme.shop.MetaDecimalWire")
        val instance = wire.getField("INSTANCE").get(null)
        fun call(name: String, vararg args: Any?): Any? {
            val m = wire.methods.first { it.name == name && it.parameterCount == args.size }
            return try { m.invoke(instance, *args) } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException }
        }
        assertEquals("100.5", call("format", java.math.BigDecimal("100.50")))
        assertEquals("0", call("format", java.math.BigDecimal("0.0000")))
        assertEquals(java.math.BigDecimal("12345678901234567.89"), call("parse", "12345678901234567.89"))
        assertEquals(java.math.BigDecimal("100.5"), (call("parse", "1.005e2") as java.math.BigDecimal).stripTrailingZeros())
        assertFailsWith<IllegalArgumentException> { call("parse", "12abc") }
        assertEquals(java.math.BigDecimal("0.3"), call("fromDouble15", 0.1 + 0.2))
        assertEquals(true, call("fits", java.math.BigDecimal("99.99"), 4, 2))
        assertEquals(false, call("fits", java.math.BigDecimal("0.001"), 4, 2))
        assertEquals(false, call("fits", java.math.BigDecimal("100.1"), 4, 2))
    }

    @Test
    fun `a precision with no scale declares scale 0, as the Java port reads it`() {
        val json = model.replace("\"@precision\": 12, \"@scale\": 2,", "\"@precision\": 12,")
        val files = emit(json, all())
        assertTrue("MetaDecimalWire.fits(dto.price, 12, 0)" in files.getValue("acme/shop/ItemController.kt"))
        assertTrue("portableDecimal(\"price\", 12, 0)" in files.getValue("acme/shop/ItemTable.kt"))
    }

    /** The shared vectors (`fixtures/decimal-wire/vectors.json`), found by walking up from the working directory. */
    private fun vectors(): com.fasterxml.jackson.databind.JsonNode {
        var dir: java.nio.file.Path? = java.nio.file.Paths.get("").toAbsolutePath()
        while (dir != null) {
            val f = dir.resolve("fixtures/decimal-wire/vectors.json")
            if (Files.isRegularFile(f)) return com.fasterxml.jackson.databind.ObjectMapper().readTree(f.toFile())
            dir = dir.parent
        }
        throw IllegalStateException("fixtures/decimal-wire/vectors.json not found")
    }

    @Test
    fun `the generated MetaDecimalWire passes every shared decimal-wire vector`() {
        val files = emit(model, listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) ->
                com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
            }
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val wire = result.classLoader.loadClass("acme.shop.MetaDecimalWire")
        val instance = wire.getField("INSTANCE").get(null)
        fun call(name: String, arg: Any?): Any? {
            val m = wire.methods.first { it.name == name && it.parameterCount == 1 }
            return try { m.invoke(instance, arg) } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException }
        }
        // W2: a body value goes through the generated Jackson deserializer, as a request body does.
        @Suppress("UNCHECKED_CAST")
        val deserializer = result.classLoader.loadClass("acme.shop.MetaDecimalWire\$Deserializer")
            .getDeclaredConstructor().newInstance() as com.fasterxml.jackson.databind.JsonDeserializer<java.math.BigDecimal>
        val mapper = com.fasterxml.jackson.databind.ObjectMapper().registerModule(
            com.fasterxml.jackson.databind.module.SimpleModule().addDeserializer(java.math.BigDecimal::class.java, deserializer))

        fun expectOrRefuse(v: com.fasterxml.jackson.databind.JsonNode, run: () -> Any?, label: String) {
            if (v.has("error") && v.get("error").asBoolean()) {
                var refused = false
                try { run() } catch (e: Exception) { refused = true }
                assertTrue(refused, "$label: expected a refusal")
            } else if (v.get("value").isNull) {
                assertEquals(null, run(), label)
            } else {
                val got = run() as java.math.BigDecimal
                assertEquals(0, got.compareTo(java.math.BigDecimal(v.get("value").asText())), "$label: got $got")
            }
        }

        val vs = vectors()
        for (v in vs.get("format")) {
            assertEquals(v.get("out").asText(), call("format", java.math.BigDecimal(v.get("in").asText())), "format ${v.get("in")}")
        }
        for (v in vs.get("parse")) {
            val json = v.get("json").asText()
            expectOrRefuse(v, { mapper.readValue(json, java.math.BigDecimal::class.java) }, "parse $json")
        }
        for (v in vs.get("filterOperand")) {
            val text = v.get("text").asText()
            expectOrRefuse(v, { call("parseFilterOperand", text) }, "filterOperand $text")
        }
        for (v in vs.get("double15")) {
            val d = v.get("double").asText().toDouble()
            assertEquals(v.get("out").asText(), call("format", call("fromDouble15", d)), "double15 ${v.get("double")}")
        }
        println("decimal-wire vectors: format=${vs.get("format").size()} parse=${vs.get("parse").size()} " +
            "filterOperand=${vs.get("filterOperand").size()} double15=${vs.get("double15").size()}")
    }
}
