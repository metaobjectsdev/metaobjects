package com.metaobjects.integration.kotlin.api.writethrough.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
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
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * #214 write-through read-your-writes — host the GENERATED Kotlin Spring `OrderController`
 * for the write-through corpus (Customer + Order: `orders` table + `@role:replica @kind:view`
 * + a derived `customerName` origin.passthrough) over HTTP (Spring MockMvc) and drive the
 * read-your-writes scenarios against it.
 *
 * Mechanism (mirrors [com.metaobjects.integration.kotlin.api.tph.generated.GeneratedTphControllerHarness]):
 *  1. Load `fixtures/api-contract-conformance/write-through/meta.json`.
 *  2. Run the four codegen-kotlin generators — the emitted `OrderController` (writes → OrderTable,
 *     reads/re-reads → OrderView), the `Order` data class, and the `OrderTable`/`OrderView`/`CustomerTable`
 *     Exposed objects are hosted UNMODIFIED.
 *  3. Compile every emitted `.kt` via kotlin-compile-testing.
 *  4. Per scenario: connect a fresh in-memory H2 (PostgreSQL mode), create the generated
 *     CustomerTable + OrderTable schema, HAND-EXEC `CREATE VIEW v_order_with_customer` (Exposed can't
 *     create a view — the generated `OrderView` is a SELECT-only `Table(...)` binding), and seed the
 *     base tables directly (the derived customerName is never seeded — the view join produces it on read).
 *  5. Host the controller on a Spring `MockMvc` `standaloneSetup`.
 *
 * The seed is raw-exec'd (not via the controller's POST) because the seeded order carries an explicit
 * id=100 that a server-assigned auto-increment POST cannot reproduce.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedWriteThroughControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val customers: List<Map<String, Any?>>,
    private val orders: List<Map<String, Any?>>,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val controllerClass: Class<*>
    private val customerTable: Table
    private val orderTable: Table
    private val dbSeq = AtomicInteger(0)
    private var mockMvc: MockMvc? = null

    init {
        val metaJson = corpusRoot.resolve("write-through/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-write-through-generated", listOf(uri))

        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinNamesGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            // Task 6 — free compile-level proof that <Entity>Names const val references
            // actually resolve; useNames is ignored by every other generator. This is
            // also the write-through lane — the ONE existing corpus fixture that
            // exercises Names substitution against emitWriteThrough's TWO Exposed
            // objects (OrderTable + OrderView) sharing one entity's column names.
            g.setArgs(mapOf("outputDir" to srcDir.toString(), "useNames" to "true"))
            g.execute(loader)
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
        this.customerTable = result.classLoader.loadClass(CUSTOMER_TABLE_FQCN).getDeclaredField("INSTANCE").get(null) as Table
        this.orderTable = result.classLoader.loadClass(ORDER_TABLE_FQCN).getDeclaredField("INSTANCE").get(null) as Table
    }

    /** Rebuild a fresh in-memory H2 + view + seed + controller + MockMvc. */
    fun reset() {
        val dbName = "wt_order_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        transaction(db) {
            SchemaUtils.create(customerTable, orderTable) // customers first (Order FK → Customer)
            // Exposed cannot CREATE a view — the generated OrderView is a SELECT-only Table binding.
            // `name` is quoted: Exposed stores it as the reserved-word-quoted lowercase column "name",
            // and H2 (PostgreSQL mode, no DATABASE_TO_LOWER) folds an UNquoted `c.name` to `NAME`,
            // which would not match. id / customer_id are unquoted (stored uppercase) and resolve as-is.
            exec(
                "CREATE VIEW v_order_with_customer AS " +
                    "SELECT o.id AS id, o.customer_id AS customer_id, c.\"name\" AS customer_name " +
                    "FROM orders o JOIN customers c ON o.customer_id = c.id",
            )
            for (c in customers) {
                exec("INSERT INTO customers (id, \"name\") VALUES (${asLong(c["id"])}, ${sqlStr(c["name"])})")
            }
            for (o in orders) {
                exec("INSERT INTO orders (id, customer_id) VALUES (${asLong(o["id"])}, ${asLong(o["customerId"])})")
            }
        }

        val controller = controllerClass
            .getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
            .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
        val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
        mockMvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()
    }

    fun exchange(method: String, path: String, jsonBody: Any?): Response {
        val mvc = mockMvc ?: error("reset() must be called before exchange(...)")
        val builder = request(HttpMethod.valueOf(method), URI.create(path))
        if (jsonBody != null) {
            builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(jsonBody))
        }
        val res = mvc.perform(builder).andReturn().response
        return Response(res.status, res.getContentAsString(StandardCharsets.UTF_8))
    }

    fun parseBody(body: String?): Any? =
        if (body.isNullOrEmpty()) null else mapper.readValue(body, Any::class.java)

    override fun close() { /* H2 in-mem reclaimed at JVM exit (DB_CLOSE_DELAY=-1). */ }

    data class Response(val status: Int, val body: String)

    private companion object {
        const val ENTITY_PKG = "acme.orders"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.OrderController"
        const val ORDER_TABLE_FQCN = "$ENTITY_PKG.OrderTable"
        const val CUSTOMER_TABLE_FQCN = "$ENTITY_PKG.CustomerTable"

        fun asLong(v: Any?): Long = (v as Number).toLong()
        fun sqlStr(v: Any?): String = "'" + (v as String).replace("'", "''") + "'"
    }
}
