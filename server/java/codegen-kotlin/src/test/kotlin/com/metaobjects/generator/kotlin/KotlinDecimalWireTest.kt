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
    fun `a decimal array is read and range-checked element by element on create and on PATCH (W2, W3)`() {
        val json = model.replace(
            "{ \"field.string\": { \"name\": \"name\", \"@maxLength\": 40 } },",
            "{ \"field.decimal\": { \"name\": \"readings\", \"isArray\": true, \"@precision\": 9, \"@scale\": 4 } },",
        )
        val files = emit(json, all())
        val controller = files.getValue("acme/shop/ItemController.kt").lines().map { it.trim() }
        fun line(prefix: String): String =
            controller.firstOrNull { it.startsWith(prefix) } ?: error("no generated line starting '$prefix':\n" + controller.joinToString("\n"))
        // The generated create range check and the generated PATCH bind + range check, run as written.
        val harness = """
            package acme.shop

            import com.fasterxml.jackson.databind.JsonNode
            import java.math.BigDecimal

            class ResponseEntity<T>(val status: Int, val body: T?) {
                class Builder { fun body(b: Any): ResponseEntity<Any> = ResponseEntity(400, b) }
                companion object { fun badRequest() = Builder() }
            }
            fun <T> transaction(block: () -> T): T = block()
            class Dto(val readings: List<BigDecimal>?)

            object Harness {
                @JvmStatic fun create(dto: Dto): ResponseEntity<Any> = transaction {
                    ${line("if (dto.readings")}
                    ResponseEntity(201, dto.readings?.map { MetaDecimalWire.format(it) })
                }
                @JvmStatic fun patch(body: JsonNode): ResponseEntity<Any> = transaction {
                    ${line("val hasReadings")}
                    ${line("val nullReadings")}
                    ${line("val vReadings")}
                    ${line("if (vReadings")}
                    ResponseEntity(200, vReadings?.map { MetaDecimalWire.format(it) })
                }
            }
        """.trimIndent()
        val sources = files.filterKeys { it.endsWith("MetaDecimalWire.kt") }.map { (path, src) ->
            com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
        } + com.tschuchort.compiletesting.SourceFile.kotlin("Harness.kt", harness)
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages + "\n" + harness)
        val cl = result.classLoader
        val h = cl.loadClass("acme.shop.Harness")
        val mapper = com.fasterxml.jackson.databind.ObjectMapper()
        fun outcome(r: Any?): Pair<Any?, Any?> {
            val c = r!!.javaClass
            return c.getMethod("getStatus").invoke(r) to c.getMethod("getBody").invoke(r)
        }
        fun patch(body: String) = outcome(h.getMethod("patch", com.fasterxml.jackson.databind.JsonNode::class.java).invoke(null, mapper.readTree(body)))
        fun create(vararg readings: String): Pair<Any?, Any?> {
            val dto = cl.loadClass("acme.shop.Dto").getConstructor(List::class.java)
                .newInstance(readings.map { java.math.BigDecimal(it) })
            return outcome(h.getMethod("create", dto.javaClass).invoke(null, dto))
        }
        val refused = mapOf("error" to "validation", "field" to "readings")

        // Oracle: ADR-0019 Amendment 1 — canonical strings (W1), exact input (W2), decimal(9, 4) range (W3).
        assertEquals(200 to listOf("100.5", "0.3", "15"), patch("""{"readings": ["100.5000", 0.3, "1.5e1"]}"""))
        assertEquals(400 to refused, patch("""{"readings": ["1", "0.12345"]}"""))
        assertEquals(400 to refused, patch("""{"readings": ["100000"]}"""))
        assertEquals(400 to refused, patch("""{"readings": ["12abc"]}"""))
        assertEquals(400 to refused, patch("""{"readings": "100.5"}"""))
        assertEquals(201 to listOf("100.5", "0"), create("100.5000", "0.0000"))
        assertEquals(400 to refused, create("1", "0.12345"))
        assertEquals(400 to refused, create("100000"))
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

    private val unsizedModel = model.replace("\"@precision\": 12, \"@scale\": 2, ", "")

    @Test
    fun `the unbounded decimal column compiles and reads a value exactly, never rounding to a scale`() {
        val files = emit(unsizedModel, listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) ->
            com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
        }
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val type = result.classLoader.loadClass("acme.shop.MetaUnboundedDecimalColumnType")
            .getDeclaredConstructor().apply { isAccessible = true }.newInstance() as org.jetbrains.exposed.sql.ColumnType<*>
        assertEquals("NUMERIC", type.sqlType())
        @Suppress("UNCHECKED_CAST")
        val t = type as org.jetbrains.exposed.sql.ColumnType<java.math.BigDecimal>
        assertEquals(java.math.BigDecimal("1.234567"), t.valueFromDB(java.math.BigDecimal("1.234567")))
        assertEquals(java.math.BigDecimal("12345678901234567890.123456789"), t.valueFromDB("12345678901234567890.123456789"))
        assertEquals("1.234567", t.nonNullValueToString(java.math.BigDecimal("1.234567")))
    }

    private val voModel = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.value": { "name": "Price", "children": [
            { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
            { "field.decimal": { "name": "free" } }
        ] } },
        { "object.entity": { "name": "Item", "children": [
            { "field.long": { "name": "id" } },
            { "field.object": { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
            { "field.object": { "name": "prices", "@objectRef": "Price", "isArray": true, "@storage": "jsonb" } },
            { "source.rdb": { "@table": "items" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `a decimal inside a jsonb value object reads a string or number exactly, checks its declared range and writes canonical`() {
        val files = emit(voModel, listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) ->
            com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
        }
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val mapper = com.fasterxml.jackson.databind.ObjectMapper().registerModule(com.fasterxml.jackson.module.kotlin.KotlinModule.Builder().build())
        val price = result.classLoader.loadClass("acme.shop.Price")
        val item = result.classLoader.loadClass("acme.shop.Item")
        fun net(json: String): String? = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(mapper.readValue(json, price)).get("net").asText()
        // A string or a JSON number, read exactly; written as the canonical string.
        assertEquals("1.5", net("""{"net":"1.5000"}"""))
        assertEquals("1234567890.12", net("""{"net":1234567890.12}"""))
        assertEquals("0", net("""{"net":"0.00"}"""))
        // Past the declared @precision/@scale is refused, never rounded.
        for (bad in listOf("""{"net":"1.234"}""", """{"net":1.234}""", """{"net":"12345678901"}""", """{"net":"NaN"}""", """{"net":""}""")) {
            val e = runCatching { mapper.readValue(bad, price) }.exceptionOrNull()
            assertTrue(e is com.fasterxml.jackson.core.JsonProcessingException, "must be refused: $bad but got $e")
        }
        // A VO decimal with no @precision is bounded only by the engine-wide limits.
        val free = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(mapper.readValue("""{"net":"1","free":"1.23456789012345678901"}""", price))
        assertEquals("1.23456789012345678901", free.get("free").asText())
        // The single and the array-of-VO members of the entity follow the same rule.
        val out = mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(
            mapper.readValue("""{"id":1,"price":{"net":"2.50"},"prices":[{"net":3},{"net":"4.10"}]}""", item))
        assertEquals("2.5", out.get("price").get("net").asText())
        assertEquals("3", out.get("prices").get(0).get("net").asText())
        assertEquals("4.1", out.get("prices").get(1).get("net").asText())
        val e = runCatching { mapper.readValue("""{"id":1,"prices":[{"net":"1.001"}]}""", item) }.exceptionOrNull()
        assertTrue(e is com.fasterxml.jackson.core.JsonProcessingException, "an excess-scale element must be refused: $e")
    }

    private val mapModel = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.value": { "name": "Tier", "children": [
            { "field.decimal": { "name": "amount", "@precision": 12, "@scale": 4 } }
        ] } },
        { "object.value": { "name": "Pricing", "children": [
            { "field.map": { "name": "tiers", "@objectRef": "Tier" } }
        ] } },
        { "object.entity": { "name": "Doc", "children": [
            { "field.long": { "name": "id" } },
            { "field.map": { "name": "tiers", "@objectRef": "Tier", "@storage": "jsonb" } },
            { "field.object": { "name": "pricing", "@objectRef": "Pricing", "@storage": "jsonb" } },
            { "source.rdb": { "@table": "docs" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `a decimal in the value objects of a field map follows the top-level rule per value, and a key named amount is just a key`() {
        val files = emit(mapModel, listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) ->
            com.tschuchort.compiletesting.SourceFile.kotlin(path.substringAfterLast('/'), src)
        }
        val result = com.tschuchort.compiletesting.KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(com.tschuchort.compiletesting.KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val mapper = com.fasterxml.jackson.databind.ObjectMapper().registerModule(com.fasterxml.jackson.module.kotlin.KotlinModule.Builder().build())
        val doc = result.classLoader.loadClass("acme.shop.Doc")
        fun roundTrip(json: String): com.fasterxml.jackson.databind.JsonNode =
            mapper.valueToTree(mapper.readValue(json, doc))
        // Top-level map and a map nested in a value object: a string or a number is read exactly,
        // written as the canonical string, for EACH value. The key "amount" is a key, not a member.
        val out = roundTrip("""{"id":1,
            "tiers":{"amount":{"amount":"1.5000"},"gold":{"amount":2.50}},
            "pricing":{"tiers":{"amount":{"amount":100},"silver":{"amount":"0.25"}}}}""")
        assertEquals("1.5", out.get("tiers").get("amount").get("amount").asText())
        assertEquals("2.5", out.get("tiers").get("gold").get("amount").asText())
        assertEquals("100", out.get("pricing").get("tiers").get("amount").get("amount").asText())
        assertEquals("0.25", out.get("pricing").get("tiers").get("silver").get("amount").asText())
        // More fraction digits than @scale (or a non-number) is refused, never rounded.
        for (bad in listOf(
            """{"id":1,"tiers":{"gold":{"amount":"0.12345"}}}""",
            """{"id":1,"tiers":{"amount":{"amount":0.12345}}}""",
            """{"id":1,"pricing":{"tiers":{"amount":{"amount":"0.12345"}}}}""",
            """{"id":1,"pricing":{"tiers":{"x":{"amount":"NaN"}}}}""",
        )) {
            val e = runCatching { mapper.readValue(bad, doc) }.exceptionOrNull()
            assertTrue(e is com.fasterxml.jackson.core.JsonProcessingException, "must be refused: $bad but got $e")
        }
        // The generated controller writes, reads and PATCHes the map column, validating each value.
        val ctl = emit(mapModel, all()).getValue("acme/shop/DocController.kt")
        assertTrue("it[tiers] = dto.tiers" in ctl, ctl)
        assertTrue("tiers = row[DocTable.tiers]" in ctl, ctl)
        assertTrue("TypeReference<kotlin.collections.Map<kotlin.String, acme.shop.Tier>>" in ctl, ctl)
        assertTrue("vTiers.values.any { validator.validate(it).isNotEmpty() }" in ctl, ctl)
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
