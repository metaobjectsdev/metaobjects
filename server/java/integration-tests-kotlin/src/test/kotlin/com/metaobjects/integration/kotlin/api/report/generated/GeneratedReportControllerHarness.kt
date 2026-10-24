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
import com.metaobjects.integration.kotlin.ScenarioEngine
import com.metaobjects.integration.kotlin.ScenarioLoader
import com.metaobjects.integration.kotlin.api.TomcatHost
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * FR-044 Plan 3: host the GENERATED Kotlin Spring controllers of the ten served reports
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
 *  4. Per scenario ([reset]): execute the committed TypeScript-produced `report/schema.<engine>.sql`
 *     verbatim (the base tables AND the real views) on a real database, then seed the base
 *     tables of `seed.json` (every top-level key but `reports`), parents first.
 *  5. Serve the controllers from one embedded Tomcat ([TomcatHost]).
 *
 * No view SQL is written here (ADR-0015: TypeScript owns it). The generated `<R>Table`
 * objects read the REAL views, so this is a full-stack lane on Postgres, SQLite and MySQL,
 * like the TypeScript and C# lanes. The seed's `reports` half (what the views return) is
 * not used: the views derive it from the base tables.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedReportControllerHarness(
    private val corpusRoot: Path,
    genDir: Path,
    /** The sub-corpus directory under the api-contract corpus: `report`, or `decimal` (same mechanics). */
    private val lane: String = "report",
    private val entityPkg: String = ENTITY_PKG,
    private val served: List<String> = SERVED,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        // A date reaches the wire as YYYY-MM-DD (Table D), not as an array or a number.
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val controllerClasses: List<Class<*>>
    private var host: TomcatHost? = null

    /** Every generated file, by path relative to the output root. */
    val emittedFiles: Set<String>

    init {
        val metaJson = corpusRoot.resolve("$lane/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-report-generated", listOf(uri))
        // ADR-0058 — this corpus's committed .metaobjects/config.json (at corpusRoot,
        // fixtures/api-contract-conformance/) declares naming.columns: literal; every field
        // here declares no @column, so the generated columns and the runtime's reads of them
        // depend on this. Read with the SAME NeutralConfig reader every port uses.
        loader.root.physicalNaming =
            com.metaobjects.config.SourceResolver.resolvePhysicalNaming(corpusRoot)
        // ADR-0019 Amendment 2: the same file pins wire (decimals: string, nullMembers: omit), so the
        // generated serializers write the portable form. Discovered by walking up from the meta file, so a
        // sub-corpus directory (jsonb/, m2m/, ...) reads the config at the api-contract corpus root.
        loader.root.wireFormat = com.metaobjects.config.SourceResolver
            .discoverWireFormat(listOf(java.nio.file.Path.of(corpusRoot.toString(), "meta.json").toUri()))
            .orElse(com.metaobjects.config.WireFormat.DEFAULT)

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
        for (report in served) {
            check("${entityPkg.replace('.', '/')}/${report}Controller.kt" in emittedFiles) {
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

        controllerClasses = served.map { result.classLoader.loadClass("$entityPkg.${it}Controller") }
    }

    /**
     * Rebuild the schema (real tables and views), the base-table seed, and Tomcat on [target].
     * The target must be empty or hold only a previous run's schema (Postgres and MySQL are
     * cleared here; a SQLite target is a fresh file per scenario).
     */
    fun reset(target: ReportDb) {
        val engine = target.engine
        val url = engine.jdbcUrl(target.baseUrl)
        val schema = ScenarioLoader.readCanonicalSchema(corpusRoot, "$lane/schema.${engine.name.lowercase()}.sql")
        DriverManager.getConnection(url, target.username, target.password).use { c ->
            c.createStatement().use { st ->
                when (engine) {
                    ScenarioEngine.POSTGRES -> {
                        st.execute("DROP SCHEMA public CASCADE")
                        st.execute("CREATE SCHEMA public")
                        st.execute(schema)
                    }
                    ScenarioEngine.MYSQL -> {
                        dropMysql(st, schema)
                        ScenarioEngine.splitStatements(schema).forEach { st.execute(it) }
                    }
                    ScenarioEngine.SQLITE -> ScenarioEngine.splitStatements(schema).forEach { st.execute(it) }
                }
                seedBaseTables(st, engine)
            }
        }
        // The generated controllers open their transactions on Exposed's default database.
        Database.connect(url, user = target.username, password = target.password)

        host?.close()
        host = TomcatHost.start(mapper, *controllerClasses.map(::instantiate).toTypedArray())
    }

    /**
     * A read-only report controller takes no arguments; a writable entity's takes the ObjectMapper
     * (the per-field PATCH bind) and a jakarta Validator (create and present-value validation).
     */
    private fun instantiate(c: Class<*>): Any {
        val ctor = c.declaredConstructors.minByOrNull { it.parameterCount }!!
        return if (ctor.parameterCount == 0) ctor.newInstance()
        else ctor.newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
    }

    /** Every top-level key of `seed.json` but `reports` is a base table, parents first, in file order. */
    @Suppress("UNCHECKED_CAST")
    private fun seedBaseTables(st: java.sql.Statement, engine: ScenarioEngine) {
        val seed = ObjectMapper().readValue(
            Files.readString(corpusRoot.resolve("$lane/seed.json")), Map::class.java,
        ) as Map<String, Any?>
        val q = if (engine == ScenarioEngine.MYSQL) "`" else "\""
        val tables = seed.filterKeys { it != SEED_REPORTS_KEY }
        check(tables.isNotEmpty()) { "$lane/seed.json: no base-table rows to seed" }
        for ((table, rows) in tables) {
            for (row in rows as List<Map<String, Any?>>) {
                val cols = row.keys.joinToString(", ") { "$q$it$q" }
                val vals = row.values.joinToString(", ") { literal(it) }
                st.execute("INSERT INTO $q$table$q ($cols) VALUES ($vals)")
            }
            // The seed writes explicit ids; move the identity past them (MySQL and SQLite continue from MAX).
            if (engine == ScenarioEngine.POSTGRES && rows.any { it.containsKey("id") }) {
                st.execute("SELECT setval(pg_get_serial_sequence('$table', 'id'), COALESCE((SELECT MAX(id) FROM \"$table\"), 1))")
            }
        }
    }

    /** MySQL keeps one database across scenarios: drop the artifact's views, then its tables. */
    private fun dropMysql(st: java.sql.Statement, schema: String) {
        val created = ScenarioEngine.splitStatements(schema).mapNotNull { MYSQL_CREATE.find(it)?.groupValues }
        created.filter { it[1] == "VIEW" }.forEach { st.execute("DROP VIEW IF EXISTS `${it[2]}`") }
        st.execute("SET FOREIGN_KEY_CHECKS = 0")
        created.filter { it[1] == "TABLE" }.forEach { st.execute("DROP TABLE IF EXISTS `${it[2]}`") }
        st.execute("SET FOREIGN_KEY_CHECKS = 1")
    }

    fun exchange(method: String, path: String, jsonBody: Any?): Response {
        val server = host ?: error("reset() must be called before exchange(...)")
        val res = server.exchange(method, path, jsonBody?.let { mapper.writeValueAsString(it) })
        return Response(res.status, res.body)
    }

    fun parseBody(body: String?): Any? = TomcatHost.parseBody(mapper, body)

    override fun close() {
        host?.close()
    }

    data class Response(val status: Int, val body: String)

    /** A database the lane runs on: [baseUrl] is the engine's JDBC URL before [ScenarioEngine.jdbcUrl] adds its session policy. */
    data class ReportDb(val engine: ScenarioEngine, val baseUrl: String, val username: String, val password: String)

    companion object {
        const val ENTITY_PKG = "acme.sales"

        /** The one top-level key of seed.json that is not a base table. */
        private const val SEED_REPORTS_KEY = "reports"

        private val MYSQL_CREATE = Regex("^CREATE (VIEW|TABLE) `([^`]+)`")

        /**
         * The reports of the corpus that declare a view. `InvoiceDays` declares none.
         * `ProductRevenue` declares `@spine` and a measure with `@default`; `InvoiceCalendar` lists
         * one time dimension at two grains; `SalesByCategory` reaches a dimension through two references.
         */
        /** The `decimal/` sub-corpus: one writable entity and the report read from it. */
        val DECIMAL_SERVED = listOf("Entry", "Sample", "EntryTotals")

        val SERVED = listOf(
            "InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceCalendar", "InvoiceDisputes",
            "ProductRevenue", "SalesByCategory", "SalesBySku", "ProductRefunds", "TicketsByTags",
        )

        /**
         * A seed value as a SQL literal. A date (`"2026-04-30"`) is a quoted string the engine
         * converts to the column's own type on insert.
         */
        private fun literal(v: Any?): String = when (v) {
            null -> "NULL"
            is Number -> v.toString()
            is Boolean -> v.toString()
            else -> "'" + v.toString().replace("'", "''") + "'"
        }
    }
}
