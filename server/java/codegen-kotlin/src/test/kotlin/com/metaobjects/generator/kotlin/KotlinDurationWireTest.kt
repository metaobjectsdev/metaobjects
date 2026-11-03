package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.Generator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `field.duration` as the Kotlin generators write it. The rule lives in a generated, per-package
 * `MetaDurationWire.kt` (the PRODUCTION helper of this port, which imports nothing from
 * MetaObjects), so the shared `fixtures/duration-wire/vectors.json` vectors run against the
 * compiled generated object; the entity, table and controller that call it compile alongside.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinDurationWireTest {

    private val model = """{
      "metadata.root": { "package": "acme::ops", "children": [
        { "object.value": { "name": "Window", "children": [
            { "field.duration": { "name": "span", "@required": true } }
        ] } },
        { "object.entity": { "name": "Job", "children": [
            { "field.long": { "name": "id" } },
            { "field.duration": { "name": "holdFor", "@required": true, "@filterable": true } },
            { "field.duration": { "name": "grace", "@filterable": true } },
            { "field.duration": { "name": "retries", "isArray": true } },
            { "field.object": { "name": "window", "@objectRef": "Window", "@storage": "jsonb" } },
            { "source.rdb": { "@table": "jobs" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun emit(generators: List<Generator>): Map<String, String> {
        val outDir = Files.createTempDirectory("kt-duration-wire-")
        try {
            val loader = loadString("duration-wire", model)
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

    private fun compile(files: Map<String, String>): ClassLoader {
        val sources = files.filterKeys { it.endsWith(".kt") }.map { (path, src) -> SourceFile.kotlin(path.substringAfterLast('/'), src) }
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        return result.classLoader
    }

    private fun vectors(): JsonNode {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.isRegularFile(p.resolve("fixtures/duration-wire/vectors.json"))) p = p.parent
        requireNotNull(p) { "fixtures/duration-wire/vectors.json not found above the working directory" }
        return ObjectMapper().readTree(p.resolve("fixtures/duration-wire/vectors.json").toFile())
    }

    @Test
    fun `the generated entity, table and controller wire a duration through MetaDurationWire`() {
        val files = emit(all())
        val entity = files.getValue("acme/ops/Job.kt")
        assertTrue("@get:JsonSerialize(using = MetaDurationWire.Serializer::class)" in entity, entity)
        assertTrue("@param:JsonDeserialize(using = MetaDurationWire.Deserializer::class)" in entity, entity)
        assertTrue("@get:JsonSerialize(contentUsing = MetaDurationWire.Serializer::class)" in entity, entity)
        val controller = files.getValue("acme/ops/JobController.kt")
        assertTrue("MetaDurationWire.parse" in controller, controller)
        assertTrue("MetaDurationWire.fromNode(body.get(\"holdFor\"))" in controller, controller)
        val allowlist = files.getValue("acme/ops/JobFilterAllowlist.kt")
        // A duration orders on every DB (interval on Postgres, microsecond count elsewhere).
        val holdForOps = allowlist.substringAfter("\"holdFor\" to setOf(").substringBefore(")")
        for (op in listOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")) assertTrue("\"$op\"" in holdForOps, allowlist)
        assertTrue("JobTable.holdFor greater (p.value as Duration)" in controller, controller)
        // Generated code names no MetaObjects package.
        for ((path, src) in files) {
            val code = src.lineSequence().filterNot { it.trimStart().let { l -> l.startsWith("*") || l.startsWith("/*") || l.startsWith("//") } }
                .joinToString("\n")
            assertFalse("com.metaobjects." in code, "$path references a MetaObjects package:\n$src")
        }
        // Spring is not on this module's test classpath: the controller compiles in
        // integration-tests-kotlin (FitnessCorpusControllerCompileTest); the rest compiles here.
        compile(files.filterKeys { !it.endsWith("Controller.kt") })
    }

    @Test
    fun `the generated MetaDurationWire passes every shared wire vector`() {
        val cl = compile(emit(listOf(KotlinEntityGenerator())))
        val wire = cl.loadClass("acme.ops.MetaDurationWire")
        val instance = wire.getField("INSTANCE").get(null)
        fun call(name: String, vararg args: Any?): Any? {
            val m = wire.methods.first { it.name == name && it.parameterCount == args.size }
            return try { m.invoke(instance, *args) } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException }
        }
        val v = vectors()
        for (c in v.get("parse")) {
            val out = call("format", call("parse", c.get("in").asText()))
            assertEquals(c.get("out").asText(), out, "parse ${c.get("in")}")
        }
        for (c in v.get("refused")) {
            assertEquals(false, call("isDuration", c.asText()), "refused '${c.asText()}'")
            assertFailsWith<IllegalArgumentException>("refused '${c.asText()}'") { call("parse", c.asText()) }
        }
        for (c in v.get("postgres")) {
            assertEquals(c.get("out").asText(), call("format", call("fromStored", c.get("in").asText())), "postgres ${c.get("in")}")
        }
        for (c in v.get("postgresRefused")) {
            assertFailsWith<IllegalArgumentException>("postgresRefused '${c.asText()}'") { call("fromStored", c.asText()) }
        }
        for (c in v.get("postgresText")) {
            assertEquals(c.get("out").asText(), call("formatPostgres", call("parse", c.get("in").asText())), "postgresText ${c.get("in")}")
        }
        // pgjdbc's PGInterval text — what a JDBC read of an interval column hands Exposed.
        for ((pg, canonical) in listOf(
            "0 years 0 mons 0 days 1 hours 30 mins 0.0 secs" to "PT1H30M",
            "0 years 0 mons 0 days 0 hours -1 mins -30.0 secs" to "-PT1M30S",
            "0 years 0 mons -1 days 2 hours 0 mins 0.0 secs" to "-PT22H",
            "0 years 0 mons 0 days 0 hours 0 mins 0.000001 secs" to "PT0.000001S",
            "0 years 0 mons 0 days 876000 hours 0 mins 0.0 secs" to "PT876000H",
        )) {
            assertEquals(canonical, call("format", call("fromStored", pg)), pg)
        }
        assertFailsWith<IllegalArgumentException> { call("fromStored", "1 years 2 mons 3 days 4 hours 5 mins 6.0 secs") }
        assertEquals("-PT1.123456S", call("format", Duration.ofSeconds(-1, -123_456_789)))
        // The stored microsecond count (SQLite / MySQL).
        for (c in v.get("storedMicros")) {
            val d = call("parse", c.get("in").asText())
            assertEquals(c.get("out").asText().toLong(), call("toMicros", d), "storedMicros ${c.get("in")}")
            assertEquals(c.get("in").asText(), call("format", call("fromMicros", c.get("out").asText().toLong())))
        }
        assertEquals(-1_000_000L, call("toMicros", Duration.ofSeconds(-1, -500)))
        assertFailsWith<IllegalArgumentException> { call("toMicros", Duration.ofSeconds(Long.MAX_VALUE / 1_000_000L + 1)) }
        // Java's Duration range is the only limit, refused past it, never wrapped.
        assertEquals("PT2562047788015215H", call("format", call("parse", "PT2562047788015215H")))
        assertFailsWith<IllegalArgumentException> { call("parse", "PT9223372036854775808S") }
        assertEquals(false, call("isDuration", "PT99999999999999999999H"))
        // No default locale changes the digits.
        val saved = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("ar-EG-u-nu-arab"))
            assertEquals("-PT1M30.000005S", call("format", Duration.ofSeconds(-90, -5_000)))
            assertEquals("-00:01:30.000005", call("formatPostgres", Duration.ofSeconds(-90, -5_000)))
        } finally {
            java.util.Locale.setDefault(saved)
        }
    }

    @Test
    fun `a duration property writes the canonical string and reads the accepted form only`() {
        val cl = compile(emit(listOf(KotlinEntityGenerator())))
        val job = cl.loadClass("acme.ops.Job")
        for (mapper in listOf(
            ObjectMapper().registerModule(com.fasterxml.jackson.module.kotlin.KotlinModule.Builder().build()),
            ObjectMapper().findAndRegisterModules(),
        )) {
            val read = mapper.readValue(
                """{"id":1,"holdFor":"-PT90S","retries":["P1D","PT0.5S"],"window":{"span":"PT5400S"}}""", job)
            val out = mapper.valueToTree<JsonNode>(read)
            assertEquals("-PT1M30S", out.get("holdFor").asText())
            assertEquals("PT24H", out.get("retries").get(0).asText())
            assertEquals("PT0.5S", out.get("retries").get(1).asText())
            assertEquals("PT1H30M", out.get("window").get("span").asText())
            for (bad in listOf("\"P1M\"", "\"1:30:00\"", "5400", "\"pt1h\"", "\"PT1.5H\"", "\"PT-1H\"")) {
                assertFailsWith<com.fasterxml.jackson.core.JacksonException>("must refuse $bad") {
                    mapper.readValue("""{"id":1,"holdFor":$bad}""", job)
                }
            }
        }
    }
}
