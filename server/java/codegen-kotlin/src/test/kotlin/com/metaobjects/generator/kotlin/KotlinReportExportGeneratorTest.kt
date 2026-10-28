package com.metaobjects.generator.kotlin

import com.metaobjects.config.WireFormat
import com.metaobjects.generator.Generator
import com.metaobjects.generator.RunAware
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals

/**
 * The `report-export` generator (the "Report export" section of `docs/features/api-contract.md`):
 * what it writes, what its shared writer does (compiled and run here), and that the routes
 * generator mounts the `?format` branch only when a `report-export` is in its run. The
 * generated controller is compiled and driven over HTTP by the report lane in
 * `integration-tests-kotlin`.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinReportExportGeneratorTest {

    private fun fixtureDir(relative: String): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve(relative)
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate $relative")
    }

    private fun model(): MetaDataLoader = loadDirectory("report-export-with", fixtureDir("fixtures/codegen-noop/reporting/with"))

    private fun emit(
        generators: List<Generator>,
        args: Map<String, String> = emptyMap(),
        wire: WireFormat = WireFormat.DEFAULT,
        run: List<Generator> = generators,
    ): Map<String, String> {
        val outDir = Files.createTempDirectory("report-export-")
        try {
            val loader = model()
            loader.root.wireFormat = wire
            for (gen in generators) {
                if (gen is RunAware) gen.setRun(run)
                gen.setArgs(mapOf("outputDir" to outDir.toString()) + args)
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

    @Test
    fun `it writes one export module per served report and one shared writer`() {
        val files = emit(listOf(KotlinReportExportGenerator()))
        assertEquals(setOf("acme/shop/StoreTotalsExport.kt", "acme/shop/ReportExportWriter.kt"), files.keys)
    }

    @Test
    fun `the options reach the writer constants`() {
        val set = writer(mapOf("xmlNulls" to "nil", "csvBom" to "true"))
        assertEquals(true, set.getField("EXPORT_CSV_BOM").get(null))
        assertEquals(true, set.getField("EXPORT_XML_NIL").get(null))
        val defaults = writer(emptyMap())
        assertEquals(false, defaults.getField("EXPORT_CSV_BOM").get(null))
        assertEquals(false, defaults.getField("EXPORT_XML_NIL").get(null))
    }

    @Test
    fun `a bad option is refused`() {
        assertFailsWith<Exception> { emit(listOf(KotlinReportExportGenerator()), mapOf("xmlNulls" to "null")) }
        assertFailsWith<Exception> { emit(listOf(KotlinReportExportGenerator()), mapOf("maxRows" to "0")) }
    }

    @Test
    fun `the routes generator mounts the format branch only when a report-export is in its run`() {
        fun routes() = listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator(), KotlinFilterAllowlistGenerator(), KotlinSpringControllerGenerator())
        val bare = emit(routes(), run = emptyList())
        val without = emit(routes())
        val with = routes().let { gens -> emit(gens, run = gens + KotlinReportExportGenerator()) }
        // A run with no report-export generator is byte-identical to one never told about its run.
        assertEquals(bare, without)
        val report = "acme/shop/StoreTotalsController.kt"
        assertNotEquals(without.getValue(report), with.getValue(report))
        // Only reports change; every other controller is byte-identical.
        for ((path, text) in without) if (path != report) assertEquals(text, with[path], path)
    }

    /** The shared writer, generated and compiled, with the entity row classes it never touches. */
    private fun writer(args: Map<String, String>, wire: WireFormat = WireFormat.DEFAULT): Class<*> {
        val files = emit(listOf(KotlinReportExportGenerator()), args, wire)
        val result = KotlinCompilation().apply {
            sources = listOf(SourceFile.kotlin("ReportExportWriter.kt", files.getValue("acme/shop/ReportExportWriter.kt")))
            inheritClassPath = true
            messageOutputStream = java.io.OutputStream.nullOutputStream()
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        return result.classLoader.loadClass("acme.shop.ReportExportWriter")
    }

    private class W(val cls: Class<*>) {
        val inst: Any = cls.getField("INSTANCE").get(null)
        private fun m(name: String, vararg types: Class<*>) = cls.getMethod(name, *types)
        fun text(v: Any?): Any = m("text", Any::class.java).invoke(inst, v)!!
        fun raw(v: Any?): Any = m("raw", Any::class.java).invoke(inst, v)!!
        fun decimal(v: java.math.BigDecimal?): Any = m("decimal", java.math.BigDecimal::class.java).invoke(inst, v)!!
        fun csv(names: List<String>, rows: List<List<Any>>): String =
            String(m("csv", List::class.java, List::class.java).invoke(inst, names, rows) as ByteArray, Charsets.UTF_8)
        fun xml(root: String, names: List<String>, rows: List<List<Any>>): String =
            String(m("xml", String::class.java, List::class.java, List::class.java).invoke(inst, root, names, rows) as ByteArray, Charsets.UTF_8)
        fun call(name: String, vararg v: Any?): Any? = cls.methods.first { it.name == name && it.parameterCount == v.size }.invoke(inst, *v)
    }

    @Test
    fun `csv quotes, uses CRLF and guards string cells only`() {
        val w = W(writer(emptyMap()))
        val out = w.csv(
            listOf("a", "b"),
            listOf(
                listOf(w.text("=SUM(1)"), w.raw(-5)),
                listOf(w.text("+1"), w.raw(null)),
                listOf(w.text("\tx"), w.text("\rx")),
                listOf(w.text("say \"hi\""), w.text("a,b")),
                listOf(w.text("l1\nl2"), w.text("")),
                listOf(w.text("-2"), w.decimal(java.math.BigDecimal("1.500"))),
            ),
        )
        assertEquals(
            "a,b\r\n'=SUM(1),-5\r\n'+1,\r\n'\tx,\"'\rx\"\r\n\"say \"\"hi\"\"\",\"a,b\"\r\n\"l1\nl2\",\r\n'-2,1.500\r\n",
            out,
        )
    }

    @Test
    fun `a decimal cell is written as the wire setting writes the list route`() {
        val value = java.math.BigDecimal("12.50")
        // native: what Jackson writes for a BigDecimal, the list route's own bytes
        val jackson = com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(value)
        assertEquals("12.50", jackson)
        val native = W(writer(emptyMap()))
        assertEquals("a\r\n$jackson\r\n", native.csv(listOf("a"), listOf(listOf(native.decimal(value)))))
        // string: the canonical form (ADR-0019 Amendment 1)
        val pinned = W(writer(emptyMap(), WireFormat(WireFormat.Decimals.STRING, WireFormat.NullMembers.OMIT)))
        assertEquals(
            "a,b,c\r\n12.5,0,1000\r\n",
            pinned.csv(listOf("a", "b", "c"), listOf(listOf(
                pinned.decimal(value), pinned.decimal(java.math.BigDecimal("0.0")), pinned.decimal(java.math.BigDecimal("1E+3")),
            ))),
        )
    }

    @Test
    fun `temporal cells keep their seconds as the json wire does`() {
        val w = W(writer(emptyMap()))
        assertEquals(
            "d,t,ldt,frac\r\n2026-01-01,10:00:00,2026-01-01T10:00:00,10:00:00.12\r\n",
            w.csv(listOf("d", "t", "ldt", "frac"), listOf(listOf(
                w.raw(java.time.LocalDate.of(2026, 1, 1)),
                w.raw(java.time.LocalTime.of(10, 0)),
                w.raw(java.time.LocalDateTime.of(2026, 1, 1, 10, 0)),
                w.raw(java.time.LocalTime.of(10, 0, 0, 120_000_000)),
            ))),
        )
    }

    @Test
    fun `the BOM constant puts one byte order mark first`() {
        assertEquals("﻿a\r\n", W(writer(mapOf("csvBom" to "true"))).csv(listOf("a"), emptyList()))
        assertEquals("a\r\n", W(writer(emptyMap())).csv(listOf("a"), emptyList()))
    }

    @Test
    fun `xml escapes text and writes a null as empty or as xsi nil`() {
        val empty = W(writer(emptyMap()))
        assertEquals(
            "<R><row><a>&lt;&amp;&gt;</a><b/></row></R>",
            empty.xml("R", listOf("a", "b"), listOf(listOf(empty.text("<&>"), empty.raw(null)))),
        )
        val nil = W(writer(mapOf("xmlNulls" to "nil")))
        assertEquals(
            "<R xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><row><a>x</a><b xsi:nil=\"true\"/></row></R>",
            nil.xml("R", listOf("a", "b"), listOf(listOf(nil.text("x"), nil.raw(null)))),
        )
    }

    @Test
    fun `the request side lists the wired formats and builds the headers`() {
        val w = W(writer(emptyMap()))
        assertEquals(true, w.call("isFormat", "csv"))
        assertEquals(false, w.call("isFormat", "CSV"))
        assertEquals(false, w.call("isFormat", ""))
        assertEquals(false, w.call("isFormat", "xlsx"))
        assertEquals(mapOf("error" to "invalid_format", "expected" to listOf("csv", "json", "xml")), w.call("invalidFormat"))
        assertEquals(mapOf("error" to "export_too_large", "maxRows" to 7), w.call("tooLarge", 7))
        assertEquals("export_with_count", (w.call("withCountRefused") as Map<*, *>)["error"])
        assertEquals(true, w.call("isTruthy", "true"))
        assertEquals(true, w.call("isTruthy", "1"))
        assertEquals(false, w.call("isTruthy", "0"))
        assertEquals("attachment; filename=\"x.csv\"", w.call("contentDisposition", "x", "csv"))
        assertEquals("text/csv; charset=utf-8", w.call("contentType", "csv"))
        assertEquals("application/xml", w.call("contentType", "xml"))
        assertEquals("application/json", w.call("contentType", "json"))
    }
}
