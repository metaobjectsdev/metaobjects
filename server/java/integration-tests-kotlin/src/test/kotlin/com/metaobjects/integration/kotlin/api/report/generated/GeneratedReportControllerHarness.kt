package com.metaobjects.integration.kotlin.api.report.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.integration.kotlin.api.TomcatHost
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * FR-044 Plan 3: host the GENERATED Kotlin Spring controllers of the four served reports
 * of the `report/` corpus over real HTTP (an embedded Tomcat). Mirrors
 * [com.metaobjects.integration.kotlin.api.projection.generated.GeneratedProjectionControllerHarness].
 *
 * Mechanism:
 *  1. Load `fixtures/api-contract-conformance/report/meta.json`.
 *  2. Run the codegen-kotlin generators. The emitted controllers are hosted UNMODIFIED: a
 *     failing scenario is a generator bug, never something fixed by hand-editing emitted code.
 *  3. Compile every emitted `.kt` together. This is the only thing that proves the emitted
 *     report controller COMPILES against its row, table and allowlist: the codegen-compile
 *     gate excludes the framework-bound route tier in every port by design.
 *  4. Per scenario: a fresh in-memory H2 (PostgreSQL mode), `SchemaUtils.create(...)` on the
 *     four generated report table objects, then the `reports` half of `seed.json`.
 *  5. Serve the four controllers from one embedded Tomcat ([TomcatHost]).
 *
 * No view SQL is written here (ADR-0015: TypeScript owns it). H2 creates each generated
 * `<R>Table` as a plain table that STANDS IN for the view, and the seed's `reports` half is
 * what the four views return for the seeded base tables. The base-table keys (`invoices`,
 * `products`, `sales`) are the full-stack lanes' input; this seam lane does not read them.
 * What this lane proves is the generated route over the generated binding, not the lowering.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedReportControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    /** `seed.json`'s `reports`: report name to the rows its view returns. */
    private val reportRows: Map<String, List<Map<String, Any?>>>,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        // A date reaches the wire as YYYY-MM-DD (Table D), not as an array or a number.
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val controllerClasses: List<Class<*>>
    private val tables: Map<String, Table>
    private val dbSeq = AtomicInteger(0)
    private var host: TomcatHost? = null

    /** Every generated file, by path relative to the output root. */
    val emittedFiles: Set<String>

    init {
        val metaJson = corpusRoot.resolve("report/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-report-generated", listOf(uri))

        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinNamesGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            g.setArgs(mapOf("outputDir" to srcDir.toString(), "useNames" to "true"))
            g.execute(loader)
        }

        val paths = Files.walk(srcDir).use { stream ->
            stream.filter { it.isRegularFile() && it.toString().endsWith(".kt") }.toList()
        }
        emittedFiles = paths.map { srcDir.relativize(it).toString().replace('\\', '/') }.toSet()

        // A served report's controller must have been emitted at all; otherwise this fails
        // downstream as a ClassNotFoundException with no hint that the emit gate was the cause.
        for (report in SERVED) {
            check("acme/sales/${report}Controller.kt" in emittedFiles) {
                "no controller was generated for the $report report; emitted=$emittedFiles"
            }
        }

        val result = KotlinCompilation().apply {
            this.sources = paths.map { SourceFile.kotlin(srcDir.relativize(it).toString().replace('/', '_'), it.readText()) }
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        check(result.exitCode == KotlinCompilation.ExitCode.OK) {
            "generated Kotlin failed to compile:\n${result.messages}"
        }

        controllerClasses = SERVED.map { result.classLoader.loadClass("$ENTITY_PKG.${it}Controller") }
        tables = SERVED.associateWith {
            result.classLoader.loadClass("$ENTITY_PKG.${it}Table").getDeclaredField("INSTANCE").get(null) as Table
        }
    }

    /** Rebuild a fresh in-memory H2, the four stand-in tables, the seed, and Tomcat. */
    fun reset() {
        val dbName = "report_invoice_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        transaction(db) {
            for ((report, table) in tables) {
                SchemaUtils.create(table)
                val rows = reportRows[report] ?: error("report/seed.json: no 'reports.$report' rows")
                for (row in rows) {
                    val fields = row.keys.toList()
                    val colList = fields.joinToString(", ") { identity(column(table, it)) }
                    val values = fields.joinToString(", ") { literal(row[it]) }
                    exec("INSERT INTO ${identity(table)} ($colList) VALUES ($values)")
                }
            }
        }

        host?.close()
        host = TomcatHost.start(mapper, *controllerClasses.map { it.getDeclaredConstructor().newInstance() }.toTypedArray())
    }

    /**
     * The generated Exposed column for a derived field name. Looked up by the PHYSICAL name
     * the generator chose (snake_case is Kotlin's default), so the seed follows whatever the
     * generator emitted rather than a spelling hardcoded here that could drift from it.
     */
    private fun column(table: Table, field: String) =
        table.columns.firstOrNull { it.name == snakeCase(field) }
            ?: error("no column for derived field '$field' on ${table.tableName}; columns=${table.columns.map { it.name }}")

    fun exchange(method: String, path: String, jsonBody: Any?): Response {
        val server = host ?: error("reset() must be called before exchange(...)")
        val res = server.exchange(method, path, jsonBody?.let { mapper.writeValueAsString(it) })
        return Response(res.status, res.body)
    }

    fun parseBody(body: String?): Any? = TomcatHost.parseBody(mapper, body)

    override fun close() {
        host?.close() // H2 in-mem is reclaimed at JVM exit (DB_CLOSE_DELAY=-1).
    }

    data class Response(val status: Int, val body: String)

    companion object {
        const val ENTITY_PKG = "acme.sales"

        /**
         * The four reports of the corpus that declare a view. `InvoiceDays` declares none.
         * `ProductRevenue` declares `@spine` and a measure with `@default`.
         */
        val SERVED = listOf("InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "ProductRevenue")

        private fun snakeCase(s: String): String = buildString {
            for (c in s) {
                if (c.isUpperCase()) { if (isNotEmpty()) append('_'); append(c.lowercaseChar()) } else append(c)
            }
        }

        /**
         * A seed value as a SQL literal. A date (`"2026-04-01"`) and the ratio (`"0.4"`, a
         * string in the seed so no float sits between it and the column's decimal) are quoted
         * strings that H2 converts to the column's own type on insert.
         */
        private fun literal(v: Any?): String = when (v) {
            null -> "NULL"
            is Number -> v.toString()
            is Boolean -> v.toString()
            else -> "'" + v.toString().replace("'", "''") + "'"
        }
    }
}
