package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.GeneratorException
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
 * FR-044 — [KotlinExposedTableGenerator] emits the read-only Exposed table of a view-backed
 * `object.report`, with one column per derived field (contract Table B), and nothing for a
 * report that has no view.
 *
 * The nine canonical reports are generated from the shared persistence corpus, the same
 * model the hand-written reference tables in `integration-tests-kotlin` map and the
 * persistence lane reads.
 *
 * A report's `@spine` and a measure's `@default` change only which columns are nullable
 * (contract Table C). No Kotlin generator reads either attribute: the shape Java's
 * `ReportShape` derives marks the field required, and a required field is already a
 * non-null column and a non-null property.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinReportTableGeneratorTest {

    private fun canonicalDir(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/persistence-conformance/canonical")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate fixtures/persistence-conformance/canonical")
    }

    /** Run [generators] over [loader] into one directory; relative path to contents. */
    private fun emit(
        loader: MetaDataLoader,
        args: Map<String, String> = emptyMap(),
        generators: List<Generator> = listOf(KotlinExposedTableGenerator()),
    ): Map<String, String> {
        val outDir = Files.createTempDirectory("report-table-")
        try {
            for (gen in generators) {
                gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "acme.shop") + args)
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

    private fun canonical(args: Map<String, String> = mapOf("columnNaming" to "literal")) =
        emit(loadDirectory("report-table-canonical", canonicalDir()), args)

    private fun assertCompiles(files: Map<String, String>) {
        val sources = files.filterKeys { it.endsWith(".kt") }
            .map { (path, text) -> SourceFile.kotlin(path.substringAfterLast('/'), text) }
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true   // Exposed, off the test classpath
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
    }

    // --- The canonical reports ---------------------------------------------------------

    @Test
    fun `a grouped report emits one column per derived field, typed and nullable by Table B`() {
        assertEquals(
            """
            |package fitness
            |
            |import org.jetbrains.exposed.sql.Table
            |
            |/** READ-ONLY VIEW — generated from view metadata; do not insert/update/delete directly. */
            |/** GENERATED — do not hand-edit. Regenerated from metadata. */
            |object ProgramMinutesTable : Table("v_program_minutes") {
            |    val program = long("program")
            |    val programTitle = varchar("programTitle", 200).nullable()
            |    val weeks = long("weeks")
            |    val longWeeks = long("longWeeks")
            |    val labels = long("labels")
            |    val slots = long("slots")
            |    val totalMinutes = long("totalMinutes").nullable()
            |    val avgMinutes = decimal("avgMinutes", 38, 18).nullable()
            |    val minMinutes = integer("minMinutes").nullable()
            |    val maxMinutes = integer("maxMinutes").nullable()
            |    val longShare = decimal("longShare", 38, 18).nullable()
            |}
            |""".trimMargin(),
            canonical().getValue("fitness/ProgramMinutesTable.kt"),
        )
    }

    @Test
    fun `every canonical report emits its table and none has a primary key`() {
        val files = canonical()
        val reports = listOf(
            "ProgramMinutes" to "v_program_minutes", "FitnessTotals" to "v_fitness_totals",
            "ProgramsByMonth" to "v_programs_by_month", "ProgramsByWeek" to "v_programs_by_week",
            "RecentPrograms" to "v_recent_programs", "AssetActivity" to "v_asset_activity",
            "ProgramRoster" to "v_program_roster", "ProgramLongWeeks" to "v_program_long_weeks",
            "FitnessTotalsFilled" to "v_fitness_totals_filled",
        )
        for ((report, view) in reports) {
            val src = files.getValue("fitness/${report}Table.kt")
            assertTrue("object ${report}Table : Table(\"$view\") {" in src, src)
            assertFalse("primaryKey" in src, src)
            assertFalse("init {" in src, src)
            assertFalse(".references(" in src, src)
            assertFalse("autoIncrement" in src, src)
        }
    }

    @Test
    fun `a day-or-coarser bucket is a date and an enum dimension is typed by the source entity's enum`() {
        val src = canonical().getValue("fitness/ProgramsByMonthTable.kt")
        assertTrue("import org.jetbrains.exposed.sql.javatime.date\n" in src, src)
        assertTrue("    val createdAtMonth = date(\"createdAtMonth\")\n" in src, src)
        // Program.status's own generated class — no generator emits a ProgramsByMonthStatus.
        assertTrue(
            "    val status = enumerationByName(\"status\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, ProgramStatus::class)\n" in src,
            src,
        )
        assertFalse("ProgramsByMonthStatus" in src, src)
        assertTrue("    val programs = long(\"programs\")\n" in src, src)
        // A sum of a currency is integer minor units, and null over no rows.
        assertTrue("    val listValue = long(\"listValue\").nullable()\n" in src, src)
    }

    @Test
    fun `an hour bucket of an instant is the instant column and brings the package helper`() {
        val files = canonical()
        val src = files.getValue("fitness/AssetActivityTable.kt")
        assertTrue("    val recordedAtHour = instantWithTimeZone(\"recordedAtHour\")\n" in src, src)
        assertTrue("    val asOfDateWeek = date(\"asOfDateWeek\")\n" in src, src)
        assertTrue("    val assets = long(\"assets\")\n" in src, src)
        assertTrue("fitness/MetaInstantWithTimeZoneColumnType.kt" in files.keys, files.keys.toString())
    }

    @Test
    fun `the naming strategy applies to the derived field name`() {
        val src = canonical(emptyMap()).getValue("fitness/ProgramMinutesTable.kt")   // snake_case default
        assertTrue("    val avgMinutes = decimal(\"avg_minutes\", 38, 18).nullable()\n" in src, src)
        assertTrue("    val programTitle = varchar(\"program_title\", 200).nullable()\n" in src, src)
    }

    @Test
    fun `the Exposed 1x mode emits the same report table against the v1 packages`() {
        val files = canonical(mapOf("columnNaming" to "literal", "exposedApi" to "1"))
        val byMonth = files.getValue("fitness/ProgramsByMonthTable.kt")
        assertTrue("import org.jetbrains.exposed.v1.core.Table\n" in byMonth, byMonth)
        assertTrue("import org.jetbrains.exposed.v1.javatime.date\n" in byMonth, byMonth)
        assertFalse("org.jetbrains.exposed.sql" in byMonth, byMonth)
        assertTrue("    val createdAtMonth = date(\"createdAtMonth\")\n" in byMonth, byMonth)
        val minutes = files.getValue("fitness/ProgramMinutesTable.kt")
        assertTrue("    val avgMinutes = decimal(\"avgMinutes\", 38, 18).nullable()\n" in minutes, minutes)
    }

    @Test
    fun `with the names generator in the run a report still binds by literal and gets no names artifact`() {
        val files = emit(
            loadDirectory("report-table-names", canonicalDir()),
            mapOf("columnNaming" to "literal", "useNames" to "true"),
            listOf(KotlinNamesGenerator(), KotlinExposedTableGenerator()),
        )
        // The entity beside it does reference its artifact, so the arg really was on.
        assertTrue("ProgramNames." in files.getValue("fitness/ProgramTable.kt"))
        val src = files.getValue("fitness/ProgramMinutesTable.kt")
        assertTrue("object ProgramMinutesTable : Table(\"v_program_minutes\") {" in src, src)
        assertTrue("    val weeks = long(\"weeks\")\n" in src, src)
        assertFalse("Names" in src, src)
        assertFalse(files.keys.any { it.endsWith("ProgramMinutesNames.kt") }, files.keys.toString())
    }

    // --- @spine and @default: what is nullable (Table C) -----------------------------------

    @Test
    fun `a spine report's key and defaulted measures are non-null columns, the rest stay nullable`() {
        // ProgramRoster: @spine Week.fkProgram. Its two dimensions are columns of the spine
        // entity (Program.id, a primary key, and Program.title, @required); the pairs
        // totalMinutes/totalMinutesOrZero and longShare/longShareOrZero are the same measure
        // without and with @default 0.
        assertEquals(
            """
            |package fitness
            |
            |import org.jetbrains.exposed.sql.Table
            |
            |/** READ-ONLY VIEW — generated from view metadata; do not insert/update/delete directly. */
            |/** GENERATED — do not hand-edit. Regenerated from metadata. */
            |object ProgramRosterTable : Table("v_program_roster") {
            |    val programKey = long("programKey")
            |    val programTitle = varchar("programTitle", 200)
            |    val weeks = long("weeks")
            |    val totalMinutes = long("totalMinutes").nullable()
            |    val totalMinutesOrZero = long("totalMinutesOrZero")
            |    val longShare = decimal("longShare", 38, 18).nullable()
            |    val longShareOrZero = decimal("longShareOrZero", 38, 18)
            |}
            |""".trimMargin(),
            canonical().getValue("fitness/ProgramRosterTable.kt"),
        )
        // The same Program.title dimension in ProgramMinutes, which has no @spine, stays
        // nullable: without @spine Table C changes nothing, and a dimension reached by @via
        // is never required there.
        assertTrue(
            "    val programTitle = varchar(\"programTitle\", 200).nullable()\n" in
                canonical().getValue("fitness/ProgramMinutesTable.kt"),
        )
        // With no dimensions and no @spine, a defaulted sum and ratio are still non-null.
        val filled = canonical().getValue("fitness/FitnessTotalsFilledTable.kt")
        assertTrue("    val totalMinutesOrZero = long(\"totalMinutesOrZero\")\n" in filled, filled)
        assertTrue("    val longShareOrZero = decimal(\"longShareOrZero\", 38, 18)\n" in filled, filled)
        assertFalse(".nullable()" in filled, filled)
    }

    /** A `measure.aggregate` on Sale: its name to its node. */
    private fun aggregate(name: String, attrs: String) =
        name to """{ "measure.aggregate": { "name": "$name", $attrs } }"""

    /** A `measure.ratio` on Sale: its name to its node. */
    private fun ratio(name: String, attrs: String) =
        name to """{ "measure.ratio": { "name": "$name", $attrs } }"""

    /**
     * `Product` and `Sale` (a to-one `fkProduct` reference), and `ProductRevenue` over Sale
     * with [reportAttrs] (a `@spine`, or nothing). [measures] are declared on Sale beside a
     * `sales` count; the report lists the product key, `sales` and every one of them.
     */
    private fun productRevenue(reportAttrs: String, measures: List<Pair<String, String>>): String = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 80 } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
        ] } },
        { "object.entity": { "name": "Sale", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "productId", "@required": true } },
            { "field.long": { "name": "amountCents" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "identity.reference": { "name": "fkProduct", "@fields": ["productId"], "@references": "Product" } },
            { "dimension.attribute": { "name": "productId", "@of": "Product.id", "@via": "Sale.fkProduct" } },
            { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } },
            ${measures.joinToString(",\n            ") { it.second }}
        ] } },
        { "object.report": { "name": "ProductRevenue", "@from": "Sale", $reportAttrs
            "@dimensions": ["productId"],
            "@measures": ["sales", ${measures.joinToString(", ") { "\"${it.first}\"" }}],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_product_revenue" } } ] } }
      ] }
    }"""

    /** The table and the row data class of `ProductRevenue`. */
    private fun productRevenueFiles(json: String): Pair<String, String> {
        val files = emit(
            loadString("report-table-spine-default", json),
            mapOf("columnNaming" to "literal"),
            listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()),
        )
        assertCompiles(files)
        return files.getValue("acme/shop/ProductRevenueTable.kt") to files.getValue("acme/shop/ProductRevenue.kt")
    }

    @Test
    fun `a defaulted measure is a non-null column and property, and the same measure without default stays nullable`() {
        val (table, row) = productRevenueFiles(productRevenue(
            """"@spine": "Sale.fkProduct",""",
            listOf(
                aggregate("revenue", """"@agg": "sum", "@of": "Sale.amountCents""""),
                aggregate("revenueOrZero", """"@agg": "sum", "@of": "Sale.amountCents", "@default": 0"""),
                aggregate("smallestOrZero", """"@agg": "min", "@of": "Sale.amountCents", "@default": 0"""),
                ratio("perSale", """"@numerator": "revenue", "@denominator": "sales""""),
                ratio("perSaleOrZero", """"@numerator": "revenue", "@denominator": "sales", "@default": 0"""),
            ),
        ))
        // The Exposed columns.
        assertTrue("    val revenueOrZero = long(\"revenueOrZero\")\n" in table, table)
        assertTrue("    val smallestOrZero = long(\"smallestOrZero\")\n" in table, table)
        assertTrue("    val perSaleOrZero = decimal(\"perSaleOrZero\", 38, 18)\n" in table, table)
        assertTrue("    val revenue = long(\"revenue\").nullable()\n" in table, table)
        assertTrue("    val perSale = decimal(\"perSale\", 38, 18).nullable()\n" in table, table)
        // The row data class: a non-null property has no `?` and no `= null` default.
        assertTrue("  public val revenueOrZero: Long,\n" in row, row)
        assertTrue("  public val smallestOrZero: Long,\n" in row, row)
        assertTrue("  public val perSaleOrZero: BigDecimal,\n" in row, row)
        assertTrue("  public val revenue: Long? = null,\n" in row, row)
        assertTrue("  public val perSale: BigDecimal? = null,\n" in row, row)
    }

    @Test
    fun `under spine the key of the spine entity is non-null, and without spine the same dimension is nullable`() {
        val sum = listOf(aggregate("revenue", """"@agg": "sum", "@of": "Sale.amountCents""""))
        // Product.id is the spine entity's primary key and carries no @required.
        val (spineTable, spineRow) = productRevenueFiles(productRevenue(""""@spine": "Sale.fkProduct",""", sum))
        assertTrue("    val productId = long(\"productId\")\n" in spineTable, spineTable)
        assertTrue("  public val productId: Long,\n" in spineRow, spineRow)
        // A count is non-null either way, and nothing else moved.
        assertTrue("    val sales = long(\"sales\")\n" in spineTable, spineTable)
        assertTrue("    val revenue = long(\"revenue\").nullable()\n" in spineTable, spineTable)

        val (plainTable, plainRow) = productRevenueFiles(productRevenue("", sum))
        assertTrue("    val productId = long(\"productId\").nullable()\n" in plainTable, plainTable)
        assertTrue("  public val productId: Long? = null,\n" in plainRow, plainRow)
        assertTrue("    val sales = long(\"sales\")\n" in plainTable, plainTable)
    }

    // --- Which reports emit (Table A) --------------------------------------------------

    /** A `Sale` entity with [measures], and a `SaleTotals` report over them with [reportSource]. */
    private fun model(
        measures: List<String> = listOf("sales"),
        reportSource: String? = """{ "source.rdb": { "@kind": "view", "@view": "v_sale_totals" } }""",
        extraMembers: String = "",
        dimensions: List<String> = emptyList(),
    ): String {
        val measureNodes = measures.joinToString(",\n") {
            """{ "measure.aggregate": { "name": "$it", "@agg": "count", "@of": "Sale.id" } }"""
        }
        val children = reportSource?.let { """, "children": [ $it ]""" } ?: ""
        val dims = if (dimensions.isEmpty()) "" else
            """ "@dimensions": [${dimensions.joinToString(",") { "\"$it\"" }}],"""
        return """{
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.timestamp": { "name": "soldAt" } },
                { "field.string": { "name": "channel" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                $extraMembers
                $measureNodes
            ] } },
            { "object.report": { "name": "SaleTotals", "@from": "Sale",$dims
                "@measures": [${measures.joinToString(",") { "\"$it\"" }}]$children } }
          ] }
        }"""
    }

    private fun reportFiles(json: String, args: Map<String, String> = emptyMap()): Map<String, String> =
        emit(loadString("report-table-model", json), args).filterKeys { "SaleTotals" in it }

    @Test
    fun `a sourceless report generates nothing`() {
        assertEquals(emptyMap(), reportFiles(model(reportSource = null)))
    }

    @Test
    fun `a managed view-backed report generates its table`() {
        val files = reportFiles(model())
        assertEquals(setOf("acme/shop/SaleTotalsTable.kt"), files.keys)
        val src = files.values.single()
        assertTrue("object SaleTotalsTable : Table(\"v_sale_totals\") {" in src, src)
        assertTrue("    val sales = long(\"sales\")\n" in src, src)
    }

    @Test
    fun `an unmanaged view and an authored-sql view exist, so each still generates the table`() {
        for (attrs in listOf(
            """"@unmanaged": true""",
            """"@sql": "SELECT COUNT(id) AS sales FROM sales"""",
        )) {
            val files = reportFiles(model(
                reportSource = """{ "source.rdb": { "@kind": "view", "@view": "v_sale_totals", $attrs } }"""))
            assertEquals(setOf("acme/shop/SaleTotalsTable.kt"), files.keys, attrs)
            assertTrue("    val sales = long(\"sales\")\n" in files.values.single(), attrs)
        }
    }

    @Test
    fun `a view named by the legacy table attr and a schema-qualified view bind that name`() {
        val legacy = reportFiles(model(
            reportSource = """{ "source.rdb": { "@kind": "view", "@table": "v_legacy" } }"""))
        assertTrue("Table(\"v_legacy\")" in legacy.values.single(), legacy.values.single())
        val qualified = reportFiles(model(
            reportSource = """{ "source.rdb": { "@kind": "view", "@view": "v_sale_totals", "@schema": "rpt" } }"""))
        assertTrue("Table(\"rpt.v_sale_totals\")" in qualified.values.single(), qualified.values.single())
    }

    @Test
    fun `a report over a kind the lowering skips generates nothing`() {
        for (kind in listOf(
            """"@kind": "materializedView", "@materializedView": "mv_sale_totals"""",
            """"@kind": "storedProc", "@procedure": "sale_totals"""",
            """"@kind": "tableFunction", "@function": "sale_totals"""",
        )) {
            assertEquals(emptyMap(), reportFiles(model(reportSource = """{ "source.rdb": { $kind } }""")), kind)
        }
    }

    // --- Names that would not compile ---------------------------------------------------

    @Test
    fun `names that are SQL keywords or Exposed Table members compile`() {
        // `order`, `user`, `group`, `rank` are ordinary dashboard names; the rest are (or
        // look like) members of Exposed's Table, which safeColumnProperty renames.
        val names = listOf(
            "order", "user", "group", "rank", "count", "name", "columns", "tableName", "source",
            "index", "fields", "primaryKey", "schemaName",
        )
        val files = reportFiles(model(measures = names))
        val src = files.getValue("acme/shop/SaleTotalsTable.kt")
        assertTrue("    val order = long(\"order\")\n" in src, src)
        // The physical column keeps the derived name; only the Kotlin property is renamed.
        assertTrue("    val columnsColumn = long(\"columns\")\n" in src, src)
        assertTrue("    val tableNameColumn = long(\"table_name\")\n" in src, src)
        assertTrue("    val schemaNameColumn = long(\"schema_name\")\n" in src, src)
        assertCompiles(files)
    }

    @Test
    fun `a measure named after a Kotlin keyword is refused, naming the report and the measure`() {
        for (keyword in listOf("in", "is", "object", "when", "fun")) {
            val e = assertFailsWith<GeneratorException>(keyword) { reportFiles(model(measures = listOf("sales", keyword))) }
            val message = e.message.orEmpty()
            assertTrue("report \"SaleTotals\"" in message, message)
            assertTrue("measure \"$keyword\"" in message, message)
            assertTrue("Kotlin keyword" in message && "Rename the measure" in message, message)
        }
    }

    @Test
    fun `a dimension named after a Kotlin keyword is refused, naming the dimension`() {
        val e = assertFailsWith<GeneratorException> {
            reportFiles(model(
                extraMembers = """{ "dimension.attribute": { "name": "class", "@of": "Sale.channel" } },""",
                dimensions = listOf("class"),
            ))
        }
        val message = e.message.orEmpty()
        assertTrue("report \"SaleTotals\"" in message && "dimension \"class\"" in message, message)
    }

    @Test
    fun `two derived fields that land on one column property are refused, naming both`() {
        val e = assertFailsWith<GeneratorException> {
            reportFiles(model(measures = listOf("source", "sourceColumn")))
        }
        val message = e.message.orEmpty()
        assertTrue("report \"SaleTotals\"" in message, message)
        assertTrue("measure \"source\"" in message && "measure \"sourceColumn\"" in message, message)
        assertTrue("\"sourceColumn\"" in message && "Rename one of them" in message, message)
    }

    @Test
    fun `a dimension and a measure that land on one column property are refused, naming both`() {
        val e = assertFailsWith<GeneratorException> {
            reportFiles(model(
                measures = listOf("fieldsColumn"),
                extraMembers = """{ "dimension.attribute": { "name": "fields", "@of": "Sale.channel" } },""",
                dimensions = listOf("fields"),
            ))
        }
        val message = e.message.orEmpty()
        assertTrue("dimension \"fields\"" in message && "measure \"fieldsColumn\"" in message, message)
    }

    @Test
    fun `a time dimension's derived name is never refused`() {
        val files = reportFiles(model(
            extraMembers = """{ "dimension.time": { "name": "source", "@of": "Sale.soldAt", "@grains": ["day"] } },""",
            dimensions = listOf("source:day"),
        ))
        assertTrue("    val sourceDay = date(\"source_day\")" in files.values.single(), files.values.single())
    }

    @Test
    fun `a report that generates no table is not refused for its names`() {
        assertEquals(emptyMap(), reportFiles(model(measures = listOf("in", "source", "sourceColumn"), reportSource = null)))
    }

    @Test
    fun `an enum dimension reached by via is typed by the enum of the entity it reads, and compiles`() {
        val json = """{
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Store", "children": [
                { "source.rdb": { "@table": "stores" } },
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "tier", "@values": ["GOLD", "SILVER"], "@required": true } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } }
            ] } },
            { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "storeId", "@required": true } },
                { "field.enum": { "name": "channel", "@values": ["WEB", "SHOP"], "@intValueMap": { "WEB": 1, "SHOP": 2 }, "@required": true } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                { "identity.reference": { "name": "storeRef", "@references": "Store", "@fields": ["storeId"] } },
                { "relationship.association": { "name": "store", "@objectRef": "Store", "@cardinality": "one" } },
                { "dimension.attribute": { "name": "storeTier", "@of": "Store.tier", "@via": "Sale.store" } },
                { "dimension.attribute": { "name": "channel", "@of": "Sale.channel" } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
            ] } },
            { "object.report": { "name": "SalesByTier", "@from": "Sale",
                "@dimensions": ["storeTier", "channel"], "@measures": ["sales"],
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_sales_by_tier" } } ] } }
          ] }
        }"""
        val files = emit(
            loadString("report-table-via-enum", json),
            generators = listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()),
        )
        val src = files.getValue("acme/shop/SalesByTierTable.kt")
        // Store's class, and nullable: a dimension reached by @via can be null.
        assertTrue(
            "    val storeTier = enumerationByName(\"store_tier\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, StoreTier::class).nullable()\n" in src,
            src,
        )
        // An int-backed enum keeps its mapping, typed by Sale's class.
        assertTrue("    val channel = customEnumeration(\"channel\", \"INTEGER\", " in src, src)
        assertTrue("1 -> SaleChannel.WEB" in src && "SaleChannel.SHOP -> 2" in src, src)
        assertFalse("SalesByTier" in src.replace("SalesByTierTable", ""), src)
        assertCompiles(files)
    }

    // --- References resolve as the loader resolves them -----------------------------------

    /** `a::Base` (abstract) declares members whose bare `@of` names `Base`. */
    private val sharedBase = """{
      "metadata.root": { "package": "a", "children": [
        { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "kind", "@maxLength": 12 } },
            { "field.enum": { "name": "tier", "@values": ["GOLD", "SILVER"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "dimension.attribute": { "name": "kind", "@of": "Base.kind" } },
            { "dimension.attribute": { "name": "tier", "@of": "Base.tier" } },
            { "measure.aggregate": { "name": "events", "@agg": "count", "@of": "Base.id" } }
        ] } }
      ] }
    }"""

    /** Package `b`: `Ev extends a::Base` and report `R` over it. [decoy] adds a same-named,
     *  differently-typed `b::Base` that a package-of-`@from` resolution would capture. */
    private fun evFile(decoy: Boolean, measures: String = """["events"]"""): String {
        val decoyNode = if (!decoy) "" else """
            { "object.entity": { "name": "Base", "children": [
                { "field.int": { "name": "id" } },
                { "field.int": { "name": "kind" } },
                { "field.int": { "name": "tier" } }
            ] } },"""
        return """{
          "metadata.root": { "package": "b", "children": [$decoyNode
            { "object.entity": { "name": "Ev", "extends": "a::Base", "children": [
                { "source.rdb": { "@table": "evs" } }
            ] } },
            { "object.report": { "name": "R", "@from": "Ev", "@dimensions": ["kind", "tier"],
                "@measures": $measures,
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_r" } } ] } }
          ] }
        }"""
    }

    private fun loadFiles(vararg json: String): MetaDataLoader =
        MetaDataLoader.createManual(false, "report-table-cross-package").apply {
            init()
            load(json.mapIndexed { i, text ->
                com.metaobjects.loader.InMemoryStringSource(
                    text, "meta.inline$i.json", com.metaobjects.loader.MetaDataSource.MetaDataFormat.JSON)
            })
            assertEquals(emptyList(), errors.map { it.message })
            register()
        }

    private fun crossPackageTable(decoy: Boolean, measures: String = """["events"]"""): Map<String, String> =
        emit(
            loadFiles(sharedBase, evFile(decoy, measures)),
            mapOf("columnNaming" to "literal"),
            listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()),
        )

    private fun assertTypedFromTheDeclaringBase(files: Map<String, String>) {
        val src = files.getValue("b/RTable.kt")
        assertTrue("    val kind = varchar(\"kind\", 12).nullable()\n" in src, src)
        // The enum class of the @from entity, which is the class the entity generator emits.
        assertTrue("EvTier::class).nullable()\n" in src, src)
        assertTrue("    val events = long(\"events\")\n" in src, src)
        assertCompiles(files.filterKeys { !it.startsWith("b/Base") })
    }

    @Test
    fun `a bare of on a member inherited from another package resolves in the declaring entity's package`() {
        assertTypedFromTheDeclaringBase(crossPackageTable(decoy = false))
    }

    @Test
    fun `a same-named decoy in the report's package does not capture the reference`() {
        // b::Base.kind and b::Base.tier are ints: captured, the columns would be integer(...).
        assertTypedFromTheDeclaringBase(crossPackageTable(decoy = true))
    }

    @Test
    fun `a dotted measures item names the measure by its last segment`() {
        val src = crossPackageTable(decoy = false, measures = """["a::Base.events"]""").getValue("b/RTable.kt")
        assertTrue("    val events = long(\"events\")\n" in src, src)
        val viaFrom = crossPackageTable(decoy = false, measures = """["Ev.events"]""").getValue("b/RTable.kt")
        assertEquals(src, viaFrom)
    }

    // --- What generates nothing, and what is refused ---------------------------------------

    @Test
    fun `an abstract view-backed report generates nothing`() {
        // An abstract object gets no table object in this port, report or not. The
        // TypeScript, Java and Python runtimes still read the view (docs: Known limits).
        val json = model().replace(""""name": "SaleTotals",""", """"name": "SaleTotals", "abstract": true,""")
        assertTrue("\"abstract\": true" in json)
        assertEquals(emptyMap(), reportFiles(json))
    }

    @Test
    fun `a dimension over a field object is refused, naming the report and the dimension`() {
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
                "@measures": ["sales"],
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_sale_totals" } } ] } }
          ] }
        }"""
        val e = assertFailsWith<GeneratorException> { reportFiles(json) }
        assertEquals(
            "report \"SaleTotals\": its dimension \"destination\" reads \"acme::shop::Sale.shipTo\", a " +
                "field.object. A report over a field.object is not supported; group by a scalar field.",
            e.message,
        )
        // The same report with no view generates nothing and is not refused.
        assertEquals(emptyMap(), reportFiles(json.replace(
            """"children": [ { "source.rdb": { "@kind": "view", "@view": "v_sale_totals" } } ]""", """"children": []""")))
    }

    // --- The emitted reports build ------------------------------------------------------

    @Test
    fun `the canonical report tables compile beside the entities they reference`() {
        val files = emit(
            loadDirectory("report-table-compile", canonicalDir()),
            mapOf("columnNaming" to "literal", "packageName" to "fitness"),
            listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator()),
        )
        assertTrue(files.keys.count { it.endsWith("Table.kt") } >= 6, files.keys.toString())
        assertCompiles(files)
    }
}
