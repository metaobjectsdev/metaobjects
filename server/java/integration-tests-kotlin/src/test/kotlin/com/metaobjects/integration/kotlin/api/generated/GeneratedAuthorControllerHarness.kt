package com.metaobjects.integration.kotlin.api.generated

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.module.SimpleModule
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
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
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
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * SP-F Unit 2 — host the GENERATED Kotlin Spring `@RestController` for the
 * `Author` corpus entity over HTTP (in-process via Spring MockMvc) and drive
 * the api-contract scenarios against it.
 *
 * Mechanism (the SP-C / SP-E generate→compile→load pattern, mirroring the Java
 * Unit-1 harness):
 *  1. Load `fixtures/api-contract-conformance/meta.json`.
 *  2. Run the four codegen-kotlin generators — [KotlinEntityGenerator] (the
 *     `Author` data class = controller request/response body),
 *     [KotlinExposedTableGenerator] (`AuthorTable`), [KotlinFilterAllowlistGenerator]
 *     (`AuthorFilterAllowlist`), and [KotlinSpringControllerGenerator]
 *     (`AuthorController`). The `AuthorController` emitted here is the artifact
 *     under test; it is hosted UNMODIFIED.
 *  3. Compile every emitted `.kt` via kotlin-compile-testing
 *     ([KotlinCompilation], `inheritClassPath = true` → Spring + Exposed +
 *     kotlinx.serialization resolve from the test classpath).
 *  4. Provide the consumer persistence seam: the Kotlin controller has NO
 *     repository interface — it embeds Exposed `transaction { AuthorTable... }`
 *     against the thread-bound DEFAULT database. So the seam is "an Exposed
 *     `Database` + the generated `AuthorTable`". The harness connects Exposed
 *     to an in-memory H2 database (no Testcontainers, per the SP-F design),
 *     creates the GENERATED `AuthorTable`'s schema, and seeds it. This
 *     in-memory DB bootstrap is the ONLY hand-written piece — test scaffolding,
 *     not a conformance subject (real DB behavior is gated by
 *     persistence-conformance). The generated controller's own qs→predicate→Exposed
 *     query translation (all FR-009 ops, sort, paging) runs genuinely end-to-end
 *     against it.
 *  5. Instantiate the generated controller and host it on a Spring `MockMvc`
 *     `standaloneSetup` (no Spring Boot context, no socket — same in-process
 *     fidelity as the TS lane's `fastify.inject`).
 *
 * The harness is re-seeded per scenario (fresh H2 database + controller +
 * MockMvc), matching the per-scenario isolation the hand-rolled lane gets from
 * TRUNCATE/seed.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedAuthorControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val seedRows: List<Map<String, Any?>>,
) : AutoCloseable {

    /**
     * Jackson mapper used by MockMvc's converter and to (de)serialize bodies.
     *
     * ADR-0036 Wave 2: the generated `Author.createdAt` is a `java.time.Instant`. Corpus
     * scenario/seed bodies are offset-less wall-clock (yyyy-MM-ddTHH:mm:ss), which Jackson's
     * default Instant deserializer rejects — so register an Instant deserializer that
     * interprets an offset-less value as UTC (the instant wire contract; mirrors the C# lane).
     */
    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())
        .registerModule(
            SimpleModule().addDeserializer(Instant::class.java, object : JsonDeserializer<Instant?>() {
                override fun deserialize(p: JsonParser, ctx: DeserializationContext): Instant? {
                    val raw = p.valueAsString
                    if (raw.isNullOrEmpty()) return null
                    val s = if (raw.endsWith("Z") || raw.contains("+")) raw else raw + "Z"
                    return Instant.parse(s)
                }
            })
        )
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val classLoader: ClassLoader
    private val controllerClass: Class<*>
    private val authorTable: Table

    /** Each scenario gets a fresh in-memory H2 database (isolation). */
    private val dbSeq = AtomicInteger(0)
    private var mockMvc: MockMvc? = null

    init {
        // 1. Load the corpus metadata.
        val metaJson = corpusRoot.resolve("meta.json")
        val uri: URI = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-generated", listOf(uri))

        // 2. Run the four generators — emit the GENERATED controller + DTO + table + filter
        //    allowlist into srcDir, UNMODIFIED.
        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinNamesGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            // Task 6 — useNames is ignored by every generator except
            // KotlinExposedTableGenerator; harmless on the others. This is the only
            // executable proof that a `<Entity>Names.SOURCE_<ROLE>_<ALIAS>`/`_COLUMN`
            // const val reference actually RESOLVES (compiles) rather than merely rendering.
            g.setArgs(mapOf("outputDir" to srcDir.toString(), "useNames" to "true"))
            g.execute(loader)
        }

        // 3. Compile every emitted .kt against the test classpath.
        val sources = Files.walk(srcDir).use { stream ->
            stream.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .map { path ->
                    // Unique source name per file (kotlin-compile-testing requires it); the
                    // package declaration inside the file controls the real FQN.
                    SourceFile.kotlin(srcDir.relativize(path).toString().replace('/', '_'), path.readText())
                }
                .toList()
        }
        check(sources.isNotEmpty()) { "no generated .kt sources under $srcDir" }

        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true   // brings Spring + Exposed + kotlinx.serialization onto the classpath
            messageOutputStream = System.out
        }.compile()
        check(result.exitCode == KotlinCompilation.ExitCode.OK) {
            "generated Kotlin failed to compile:\n${result.messages}"
        }

        // 4. Load the compiled generated classes.
        this.classLoader = result.classLoader
        this.controllerClass = classLoader.loadClass(CONTROLLER_FQCN)
        // The generated AuthorTable is a Kotlin `object` — its singleton is in INSTANCE.
        this.authorTable = classLoader.loadClass(TABLE_FQCN)
            .getDeclaredField("INSTANCE").get(null) as Table
    }

    /**
     * Re-seed for a scenario. `seed=false` hosts an empty table (the `list-empty`
     * scenario's TRUNCATE analogue); otherwise the 5 corpus authors are loaded fresh.
     *
     * A NEW in-memory H2 database is connected each call so scenarios don't bleed into
     * each other. Exposed binds the most-recently-connected Database as the thread default,
     * which is what the generated controller's bare `transaction { }` blocks resolve.
     */
    fun reset(seed: Boolean) {
        val dbName = "sp_f_author_${dbSeq.incrementAndGet()}"
        val db = Database.connect(
            "jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL",
            driver = "org.h2.Driver",
        )
        // Create the GENERATED table's schema (DDL through Exposed — exact dialect-correct
        // identifiers).
        transaction(db) { SchemaUtils.create(authorTable) }

        // FR-036: the generated controller ctor now also takes a jakarta Validator (POST +
        // present-PATCH-value enforcement) — supply a real hibernate-validator instance.
        val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
            .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
        val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
        val mvc = MockMvcBuilders.standaloneSetup(controller)
            .setMessageConverters(converter)
            .build()
        mockMvc = mvc

        if (seed) {
            // #203/ADR-0045: seed via a DIRECT Exposed insert against the GENERATED AuthorTable —
            // NOT the controller's POST. The generated controller now STAMPS @autoSet columns on
            // create (autoCreatedAt/autoUpdatedAt := now()), so a POST-seeded row would carry a
            // 2026 now() instead of the seed's OLD sentinel — making the autoset-patch
            // `fieldsNotEqual` assertion timing-fragile (the PATCH-bumped autoUpdatedAt could
            // coincide with a POST-stamped autoCreatedAt from the same second). A direct insert
            // writes the seed's OLD autoCreatedAt/autoUpdatedAt verbatim, so the later PATCH bumps
            // autoUpdatedAt to now() while autoCreatedAt stays OLD — the two diverge robustly.
            //
            // `id` is OMITTED so the auto-increment PK assigns 1..5 in order (empty table), exactly
            // as the prior POST-seed did — the next implicit-id insert (create-201) still lands at 6.
            // Columns are matched by NAME normalized (lowercase, underscores stripped) so the field
            // camelCase (autoCreatedAt) resolves to the generated snake_case physical column
            // (auto_created_at) regardless of naming strategy; typed inserts (not raw SQL) let Exposed
            // handle all dialect identifier quoting.
            val colsByNorm = authorTable.columns.associateBy { normalizeColName(it.name) }
            fun columnFor(field: String): Column<Any?> {
                @Suppress("UNCHECKED_CAST")
                return (colsByNorm[normalizeColName(field)]
                    ?: error("generated AuthorTable has no column for field '$field'")) as Column<Any?>
            }
            transaction(db) {
                for (r in seedRows) {
                    authorTable.insert { stmt ->
                        stmt[columnFor("name")] = r["name"] as String?
                        stmt[columnFor("bio")] = r["bio"] as String?
                        stmt[columnFor("createdAt")] = parseSeedInstant(r["createdAt"] as String)
                        // FR-037 R1: the @mutability "writeOnce" column, seeded verbatim so a
                        // later PATCH can be observed to leave it alone.
                        stmt[columnFor("issuedCurrency")] = r["issuedCurrency"] as String?
                        stmt[columnFor("autoCreatedAt")] = parseSeedInstant(r["autoCreatedAt"] as String)
                        stmt[columnFor("autoUpdatedAt")] = parseSeedInstant(r["autoUpdatedAt"] as String)
                    }
                }
            }
        }
    }

    /** Normalize a column/field name for camelCase↔snake_case-insensitive matching. */
    private fun normalizeColName(s: String): String = s.lowercase().replace("_", "")

    /**
     * Parse a corpus offset-less wall-clock timestamp (yyyy-MM-ddTHH:mm:ss) as a UTC [Instant]
     * (the instant wire contract — mirrors this harness's Jackson Instant deserializer). Used by
     * the direct-insert seed to write the @autoSet sentinel values verbatim.
     */
    private fun parseSeedInstant(raw: String): Instant {
        val s = if (raw.endsWith("Z") || raw.contains("+")) raw else raw + "Z"
        return Instant.parse(s)
    }

    /** Issue a scenario request and return the (status, body-string) pair. */
    fun exchange(method: String, path: String, jsonBody: Any?): Response {
        val mvc = mockMvc ?: error("reset(...) must be called before exchange(...)")
        val builder = request(HttpMethod.valueOf(method), URI.create(path))
        if (jsonBody != null) {
            builder.contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(jsonBody))
        }
        val res = mvc.perform(builder).andReturn().response
        return Response(res.status, res.getContentAsString(StandardCharsets.UTF_8))
    }

    /** Parse a response body string into Map/List/scalar/null (the assertion shape). */
    fun parseBody(body: String?): Any? =
        if (body.isNullOrEmpty()) null else mapper.readValue(body, Any::class.java)

    override fun close() {
        // H2 in-memory databases are released when the last connection closes; DB_CLOSE_DELAY=-1
        // keeps them for the test lifetime, reclaimed at JVM exit. Nothing to close explicitly.
    }

    /** HTTP status + raw body string. */
    data class Response(val status: Int, val body: String)

    private companion object {
        const val ENTITY_PKG = "acme.blog"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.AuthorController"
        const val TABLE_FQCN = "$ENTITY_PKG.AuthorTable"
    }
}
