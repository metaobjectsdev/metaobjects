package com.metaobjects.integration.kotlin.api.projection.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.integration.kotlin.api.TomcatHost
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
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
 * F22 — host the GENERATED Kotlin Spring `InvoiceSummaryController` for the view-only
 * projection corpus over real HTTP (an embedded Tomcat) and drive the `projection/` scenarios
 * against it. Mirrors [com.metaobjects.integration.kotlin.api.writethrough.generated.GeneratedWriteThroughControllerHarness].
 *
 * Mechanism:
 *  1. Load `fixtures/api-contract-conformance/projection/meta.json`.
 *  2. Run the codegen-kotlin generators. The emitted read-only `InvoiceSummaryController`
 *     (list + get + a 405 on every write verb) is hosted UNMODIFIED — a failing scenario is
 *     a generator bug, never something fixed by hand-editing emitted code.
 *  3. Compile every emitted `.kt` via kotlin-compile-testing. This is also the only thing
 *     that proves the emitted read-only controller COMPILES: the codegen-compile gate
 *     excludes the framework-bound route tier in every port by design.
 *  4. Per scenario: fresh in-memory H2 (PostgreSQL mode), `SchemaUtils.create(InvoiceTable)`,
 *     then HAND-EXEC `CREATE VIEW v_invoice_summary` (Exposed cannot create a view — the
 *     generated `InvoiceSummaryTable` is a SELECT-only binding), then seed `invoices`.
 *  5. Serve the controller from an embedded Tomcat over a real socket ([TomcatHost]).
 *
 * The view is `SELECT *` over `invoices` on purpose. The projection declares exactly the base
 * entity's four fields, so both generated Exposed objects derive the same physical column
 * names under the same naming strategy — and `SELECT *` therefore cannot disagree with either
 * of them, whereas a hand-spelled column list silently could.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedProjectionControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val invoices: List<Map<String, Any?>>,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val controllerClass: Class<*>
    private val invoiceTable: Table
    private val dbSeq = AtomicInteger(0)
    private var host: TomcatHost? = null

    init {
        val metaJson = corpusRoot.resolve("projection/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-projection-generated", listOf(uri))

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

        // The projection's controller must have been emitted at all — otherwise this fails
        // downstream as a ClassNotFoundException with no hint that the emit gate, and not
        // the harness, was the cause.
        val emittedController = srcDir.resolve("acme/sales/InvoiceSummaryController.kt")
        check(Files.exists(emittedController)) {
            "no controller was generated for the InvoiceSummary projection at $emittedController " +
                "— the F22 emit gate did not admit it"
        }

        val sources = Files.walk(srcDir).use { stream ->
            stream.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .map { path -> SourceFile.kotlin(srcDir.relativize(path).toString().replace('/', '_'), path.readText()) }
                .toList()
        }
        check(sources.isNotEmpty()) { "no generated .kt sources under $srcDir" }

        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        check(result.exitCode == KotlinCompilation.ExitCode.OK) {
            "generated Kotlin failed to compile:\n${result.messages}"
        }

        this.controllerClass = result.classLoader.loadClass(CONTROLLER_FQCN)
        this.invoiceTable = result.classLoader.loadClass(INVOICE_TABLE_FQCN)
            .getDeclaredField("INSTANCE").get(null) as Table
    }

    /** Rebuild a fresh in-memory H2 + view + seed + controller + Tomcat. */
    fun reset() {
        val dbName = "projection_invoice_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        transaction(db) {
            SchemaUtils.create(invoiceTable)
            exec("CREATE VIEW v_invoice_summary AS SELECT * FROM ${identity(invoiceTable)}")
            val cols = SEED_FIELDS.map { field -> column(field) }
            val colList = cols.joinToString(", ") { identity(it) }
            for (row in invoices) {
                val values = SEED_FIELDS.joinToString(", ") { field -> literal(row[field]) }
                exec("INSERT INTO ${identity(invoiceTable)} ($colList) VALUES ($values)")
            }
        }

        val controller = controllerClass.getDeclaredConstructor().newInstance()
        host?.close()
        host = TomcatHost.start(mapper, controller)
    }

    /**
     * The generated Exposed column for a metadata field name. Looked up by the PHYSICAL name
     * the generator chose (snake_case is Kotlin's default), so the seed follows whatever the
     * generator emitted rather than a spelling hardcoded here that could drift from it.
     */
    private fun column(field: String) =
        invoiceTable.columns.firstOrNull { it.name == snakeCase(field) }
            ?: error(
                "no column for metadata field '$field' on ${invoiceTable.tableName}; " +
                    "columns=${invoiceTable.columns.map { it.name }}",
            )

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

    private companion object {
        const val ENTITY_PKG = "acme.sales"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.InvoiceSummaryController"
        const val INVOICE_TABLE_FQCN = "$ENTITY_PKG.InvoiceTable"

        /** The seed row keys, in `invoices` column order. */
        val SEED_FIELDS = listOf("id", "reference", "status", "amountCents")

        fun snakeCase(s: String): String = buildString {
            for (c in s) {
                if (c.isUpperCase()) { if (isNotEmpty()) append('_'); append(c.lowercaseChar()) } else append(c)
            }
        }

        fun literal(v: Any?): String = when (v) {
            null -> "NULL"
            is Number -> v.toString()
            is Boolean -> v.toString()
            else -> "'" + v.toString().replace("'", "''") + "'"
        }
    }
}
