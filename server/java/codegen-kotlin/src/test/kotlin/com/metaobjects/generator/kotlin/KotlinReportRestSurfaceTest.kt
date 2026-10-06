package com.metaobjects.generator.kotlin

import com.metaobjects.MetaDataException
import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.apidocs.ApiSymbolKind
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadDirectory
import com.metaobjects.metadata.ktx.loadString
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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-044 Plan 3: a SERVED `object.report` (its read source is `@kind: view`) gets the
 * keyless read-only REST surface in Kotlin: its row data class, its filter allowlist and a
 * read-only Spring controller, beside the Exposed table Plan 2 already emits. A report that
 * is not served gets none of them.
 *
 * The four files must agree, because the controller names the other three: it maps a
 * `ResultRow` of `<R>Table` into `<R>` and gates filters through `<R>FilterAllowlist`. So
 * every generator reaches the report through `RestSurfaceGate.restShapeOf`, and an enum
 * column is typed by one class everywhere.
 *
 * This module has Exposed on its test classpath and no Spring, so the data class, table and
 * allowlist are COMPILED here and the controller is asserted as text. The controller is
 * compiled and driven over HTTP by the report lane in `integration-tests-kotlin`.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinReportRestSurfaceTest {

    private fun fixtureDir(relative: String): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve(relative)
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate $relative")
    }

    private fun restSurface(): List<Generator> = listOf(
        KotlinEntityGenerator(), KotlinExposedTableGenerator(),
        KotlinFilterAllowlistGenerator(), KotlinSpringControllerGenerator(),
    )

    /** Run [generators] over [loader] into one directory; relative path to contents. */
    private fun emit(
        loader: MetaDataLoader,
        generators: List<Generator> = restSurface(),
        args: Map<String, String> = emptyMap(),
    ): Map<String, String> {
        val outDir = Files.createTempDirectory("report-rest-")
        try {
            for (gen in generators) {
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

    private fun withModel() = loadDirectory("report-rest-with", fixtureDir("fixtures/codegen-noop/reporting/with"))

    private fun canonical() =
        loadDirectory("report-rest-canonical", fixtureDir("fixtures/persistence-conformance/canonical"))

    /** Compile everything but the controllers: Spring is not on this module's classpath. */
    private fun assertCompilesWithoutControllers(files: Map<String, String>) {
        val sources = files.filterKeys { it.endsWith(".kt") && !it.endsWith("Controller.kt") }
            .map { (path, text) -> SourceFile.kotlin(path.replace('/', '_'), text) }
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true   // Exposed and jakarta.validation, off the test classpath
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
    }

    // --- Which reports are served (Table A) ---------------------------------------------

    @Test
    fun `a served report emits exactly its data class, table, allowlist and controller`() {
        val files = emit(withModel())
        assertEquals(
            listOf(
                "acme/shop/StoreTotals.kt", "acme/shop/StoreTotalsController.kt",
                "acme/shop/StoreTotalsFilterAllowlist.kt", "acme/shop/StoreTotalsTable.kt",
            ),
            files.keys.filter { "StoreTotals" in it },
        )
    }

    @Test
    fun `a sourceless report emits nothing`() {
        val files = emit(withModel())
        for (report in listOf("ProgramEngagement", "DailyRevenue")) {
            val hits = files.filter { (path, text) -> report in path || report in text }.keys
            assertTrue(hits.isEmpty(), "$report leaked into $hits")
        }
    }

    private fun saleTotals(reportAttrs: String = "", source: String? = VIEW): String {
        val children = source?.let { """, "children": [ $it ]""" } ?: ""
        return """{
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "channel", "@maxLength": 20, "@required": true } },
                { "field.decimal": { "name": "weight", "@precision": 10, "@scale": 2 } },
                { "field.float": { "name": "score" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                { "dimension.attribute": { "name": "source", "@of": "Sale.channel" } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } },
                { "measure.aggregate": { "name": "heaviest", "@agg": "max", "@of": "Sale.weight" } },
                { "measure.aggregate": { "name": "topScore", "@agg": "max", "@of": "Sale.score" } },
                { "measure.aggregate": { "name": "avgWeight", "@agg": "avg", "@of": "Sale.weight" } }
            ] } },
            { "object.report": { "name": "SaleTotals", $reportAttrs "@from": "Sale", "@dimensions": ["source"],
                "@measures": ["sales", "heaviest", "topScore", "avgWeight"]$children } }
          ] }
        }"""
    }

    private fun saleTotalsFiles(json: String): Map<String, String> =
        emit(loadString("report-rest-model", json)).filterKeys { "SaleTotals" in it }

    @Test
    fun `only a concrete report over a view is served`() {
        assertEquals(4, saleTotalsFiles(saleTotals()).size)
        assertEquals(emptyMap(), saleTotalsFiles(saleTotals(source = null)), "sourceless")
        assertEquals(emptyMap(), saleTotalsFiles(saleTotals(reportAttrs = """"abstract": true,""")), "abstract")
        for (kind in listOf(
            """"@kind": "materializedView", "@materializedView": "mv_sale_totals"""",
            """"@kind": "storedProc", "@procedure": "sale_totals"""",
            """"@kind": "tableFunction", "@function": "sale_totals"""",
        )) {
            assertEquals(emptyMap(), saleTotalsFiles(saleTotals(source = """{ "source.rdb": { $kind } }""")), kind)
        }
    }

    // --- The row data class -------------------------------------------------------------

    @Test
    fun `the row is an immutable data class with one property per derived field, nullable by Table B`() {
        val src = emit(withModel()).getValue("acme/shop/StoreTotals.kt")
        assertTrue("public data class StoreTotals(" in src, src)
        assertTrue("  public val purchases: Long,\n" in src, src)
        assertTrue("  public val buyers: Long,\n" in src, src)
        assertTrue("  public val revenue: Long? = null,\n" in src, src)
        // Read from the view, never constructed or bound: no builder, no constraint.
        assertFalse("Builder" in src, src)
        assertFalse(Regex("""\bvar\s+\w""").containsMatchIn(src), src)
        assertFalse("jakarta" in src, src)
    }

    @Test
    fun `a derived enum field is typed by the enum of the entity it reads, the class its table uses`() {
        val files = emit(canonical(), listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()))
        val row = files.getValue("fitness/ProgramsByMonth.kt")
        val table = files.getValue("fitness/ProgramsByMonthTable.kt")
        assertTrue("  public val status: ProgramStatus" in row, row)
        assertTrue("ProgramStatus::class" in table, table)
        // No generator materializes an enum for the report.
        assertFalse(files.keys.any { "ProgramsByMonthStatus" in it }, files.keys.toString())
        assertFalse("ProgramsByMonthStatus" in row, row)
    }

    @Test
    fun `a time bucket is a date and a ratio is a decimal`() {
        val files = emit(canonical(), listOf(KotlinEntityGenerator()))
        assertTrue("  public val createdAtMonth: LocalDate,\n" in files.getValue("fitness/ProgramsByMonth.kt"))
        assertTrue("  public val longShare: BigDecimal? = null,\n" in files.getValue("fitness/ProgramMinutes.kt"))
    }

    @Test
    fun `a served report over a field object is refused by the row generator, naming the report`() {
        val json = """{
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.value": { "name": "Address", "children": [ { "field.string": { "name": "city" } } ] } },
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "jsonb" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                { "dimension.attribute": { "name": "destination", "@of": "Sale.shipTo" } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
            ] } },
            { "object.report": { "name": "SaleTotals", "@from": "Sale", "@dimensions": ["destination"],
                "@measures": ["sales"], "children": [ $VIEW ] } }
          ] }
        }"""
        for (gen in listOf(KotlinEntityGenerator(), KotlinFilterAllowlistGenerator(), KotlinSpringControllerGenerator())) {
            val e = assertFailsWith<MetaDataException>(gen.javaClass.simpleName) {
                emit(loadString("report-rest-object", json), listOf(gen))
            }
            assertTrue("report 'SaleTotals'" in e.message.orEmpty() && "field.object" in e.message.orEmpty(), e.message)
        }
    }

    // --- The allowlist (Table C) --------------------------------------------------------

    @Test
    fun `every derived field with a filter band is in the allowlist, with its subtype's operators`() {
        assertEquals(
            """
            |package acme.shop
            |
            |/**
            | * GENERATED — per-entity FR-009 filter allowlist for StoreTotals.
            | * FIELDS lists the filterable field names; OPS_BY_FIELD constrains the
            | * operator vocabulary for each field by its subtype.
            | */
            |object StoreTotalsFilterAllowlist {
            |    val FIELDS: Set<String> = setOf(
            |        "purchases",
            |        "buyers",
            |        "revenue",
            |    )
            |
            |    val OPS_BY_FIELD: Map<String, Set<String>> = mapOf(
            |        "purchases" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
            |        "buyers" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"),
            |        "revenue" to setOf("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")
            |    )
            |}
            |""".trimMargin(),
            emit(withModel()).getValue("acme/shop/StoreTotalsFilterAllowlist.kt"),
        )
    }

    @Test
    fun `a report with more than ten filterable fields emits one allowlist entry per field`() {
        // The Java allowlist stopped at ten pairs (Map.of); Kotlin's mapOf is vararg. Pinned
        // on the report that found it: ProgramMinutes derives eleven fields.
        val src = emit(canonical(), listOf(KotlinFilterAllowlistGenerator()))
            .getValue("fitness/ProgramMinutesFilterAllowlist.kt")
        assertEquals(11, Regex("""" to setOf\(""").findAll(src).count(), src)
    }

    // --- The controller (Table B) -------------------------------------------------------

    @Test
    fun `the controller serves the list, refuses POST with 405 and mounts no item route`() {
        val src = emit(withModel()).getValue("acme/shop/StoreTotalsController.kt")
        assertTrue("@RequestMapping(\"/api/store_totals\")" in src, src)
        assertEquals(1, Regex("@GetMapping").findAll(src).count(), src)
        assertTrue("    @PostMapping\n    fun create(): ResponseEntity<Any> = methodNotAllowed()\n" in src, src)
        assertTrue("\"error\" to \"method_not_allowed\"" in src, src)
        assertFalse("{id}" in src, src)
        assertFalse("PathVariable" in src || "RequestMethod" in src, src)
        // Reads the generated table object into the generated row, through the allowlist.
        assertTrue("private fun rowToStoreTotals(row: ResultRow): StoreTotals = StoreTotals(" in src, src)
        assertTrue("    revenue = row[StoreTotalsTable.revenue],\n" in src, src)
        assertTrue("StoreTotalsFilterAllowlist.FIELDS" in src, src)
        // Every derived field is sortable.
        assertTrue(
            "private val StoreTotalsSortAllowlist = setOf(\n    \"purchases\",\n    \"buyers\",\n    \"revenue\",\n)" in src,
            src,
        )
        // No write path, and the prose names what it is.
        for (write in listOf(".insert", ".update", "deleteWhere", "RequestBody", "Validator")) {
            assertFalse(write in src, "$write in:\n$src")
        }
        assertTrue("READ-ONLY REST controller for the StoreTotals report." in src, src)
        assertTrue("writes are not supported on a report (read-only)." in src, src)
        assertFalse("projection" in src, src)
    }

    @Test
    fun `a projection's read-only controller still says projection`() {
        val json = """{
          "metadata.root": { "package": "acme::report", "children": [
            { "object.projection": { "name": "SalesReport", "children": [
                { "field.long": { "name": "total" } },
                { "source.rdb": { "@table": "v_sales_report", "@kind": "view" } }
            ] } }
          ] }
        }"""
        val src = emit(loadString("report-rest-projection", json), listOf(KotlinSpringControllerGenerator()))
            .getValue("acme/report/SalesReportController.kt")
        assertTrue("READ-ONLY REST controller for the SalesReport projection." in src, src)
        assertTrue("writes are not supported on a projection (read-only)." in src, src)
    }

    @Test
    fun `the controller reads a column the table renamed through the renamed property`() {
        // `source` is a member of Exposed's Table, so the table declares `sourceColumn`.
        val files = saleTotalsFiles(saleTotals())
        assertTrue("    val sourceColumn = varchar(\"source\", 20)" in files.getValue("acme/shop/SaleTotalsTable.kt"))
        val src = files.getValue("acme/shop/SaleTotalsController.kt")
        assertTrue("    source = row[SaleTotalsTable.sourceColumn],\n" in src, src)
        assertTrue("\"eq\" -> SaleTotalsTable.sourceColumn eq (p.value as String)" in src, src)
        assertTrue("\"source\" -> SaleTotalsTable.sourceColumn\n" in src, src)
        assertFalse("SaleTotalsTable.source]" in src || "SaleTotalsTable.source " in src, src)
    }

    @Test
    fun `a decimal and a float filter value are coerced to the column's own type`() {
        // The dispatch arm casts to the column type, so a Double would be a ClassCastException.
        val src = saleTotalsFiles(saleTotals()).getValue("acme/shop/SaleTotalsController.kt")
        assertTrue("        \"heaviest\" -> coerceSaleTotalsDecimal(op, raw)\n" in src, src)
        assertTrue("        \"avgWeight\" -> coerceSaleTotalsDecimal(op, raw)\n" in src, src)
        assertTrue("        \"topScore\" -> coerceSaleTotalsFloat(op, raw)\n" in src, src)
        assertTrue("runCatching { java.math.BigDecimal(s) }" in src, src)
        assertTrue("runCatching { java.lang.Float.parseFloat(s) }" in src, src)
        assertTrue("\"gt\" -> SaleTotalsTable.avgWeight greater (p.value as BigDecimal)" in src, src)
    }

    @Test
    fun `a model with no float or decimal column gets neither coercer`() {
        val src = emit(withModel()).getValue("acme/shop/StoreTotalsController.kt")
        assertFalse("coerceStoreTotalsDecimal" in src || "coerceStoreTotalsFloat" in src, src)
    }

    @Test
    fun `an int-backed enum dimension filters through the enum class its table is typed by`() {
        val json = """{
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "channel", "@values": ["WEB", "SHOP"], "@intValueMap": { "WEB": 1, "SHOP": 2 }, "@required": true } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                { "dimension.attribute": { "name": "channel", "@of": "Sale.channel" } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
            ] } },
            { "object.report": { "name": "SalesByChannel", "@from": "Sale",
                "@dimensions": ["channel"], "@measures": ["sales"], "children": [ $VIEW ] } }
          ] }
        }"""
        val files = emit(loadString("report-rest-int-enum", json))
        assertTrue("  public val channel: SaleChannel,\n" in files.getValue("acme/shop/SalesByChannel.kt"))
        val src = files.getValue("acme/shop/SalesByChannelController.kt")
        assertTrue("acme.shop.SaleChannel.entries.firstOrNull { it.name == (p.value as String) }" in src, src)
        assertFalse("SalesByChannelChannel" in files.toString(), "a per-report enum leaked")
        assertCompilesWithoutControllers(files)
    }

    // --- The emitted tree builds --------------------------------------------------------

    @Test
    fun `the served report's row, table and allowlist compile together`() {
        assertCompilesWithoutControllers(emit(withModel()))
    }

    @Test
    fun `the six canonical reports' rows, tables and allowlists compile beside their entities`() {
        val files = emit(canonical(), args = mapOf("columnNaming" to "literal"))
        for (report in listOf(
            "ProgramMinutes", "FitnessTotals", "ProgramsByMonth", "ProgramsByWeek", "RecentPrograms", "AssetActivity",
        )) {
            for (suffix in listOf("", "Table", "FilterAllowlist", "Controller")) {
                assertTrue("fitness/$report$suffix.kt" in files, "$report$suffix missing from ${files.keys}")
            }
        }
        assertCompilesWithoutControllers(files)
    }

    // --- Api docs (Table G) -------------------------------------------------------------

    @Test
    fun `api docs document a served report as a list and nothing else`() {
        val model = KotlinApiModelBuilder().build(withModel(), "shop")
        val unit = model.units.single { it.node == "StoreTotals" }
        assertEquals("report", unit.kind)
        assertEquals(
            listOf(
                ApiSymbolKind.MODEL to "data class StoreTotals",
                ApiSymbolKind.DATA_ACCESS to "object StoreTotalsTable : Table",
                ApiSymbolKind.REST to "GET /api/store_totals",
                ApiSymbolKind.FILTER to "object StoreTotalsFilterAllowlist",
            ),
            unit.symbols.map { it.kind to it.signature },
        )
        assertFalse(model.units.any { it.node == "DailyRevenue" || it.node == "ProgramEngagement" })
    }

    private companion object {
        const val VIEW = """{ "source.rdb": { "@kind": "view", "@view": "v_sale_totals" } }"""
    }
}
