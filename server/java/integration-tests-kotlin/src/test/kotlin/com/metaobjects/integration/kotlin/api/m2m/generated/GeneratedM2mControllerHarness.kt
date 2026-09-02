package com.metaobjects.integration.kotlin.api.m2m.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import org.springframework.http.HttpMethod
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * FR-018 Unit 11 (Kotlin) — host the GENERATED Kotlin Spring `@RestController`s for
 * the shared M:N corpus (`Post`/`Person`) over HTTP (in-process via Spring MockMvc)
 * and drive the M:N traversal scenarios against them.
 *
 * Mechanism (the SP-F generate→compile→load pattern, mirroring the Kotlin Author
 * harness — but adding [KotlinRelationsGenerator], whose `<Source>Table.<relation>Query`
 * Exposed join helper the generated controller's M:N endpoints call):
 *  1. Load `fixtures/api-contract-conformance/m2m/meta.json`.
 *  2. Run the five generators — [KotlinEntityGenerator] (the `Tag`/`Person`/... data
 *     classes = controller response bodies), [KotlinExposedTableGenerator] (the six
 *     `<Entity>Table` objects), [KotlinRelationsGenerator] (the
 *     `<Source>Relations.kt` M:N junction-join query helpers), [KotlinFilterAllowlistGenerator],
 *     and [KotlinSpringControllerGenerator] (the controllers). The `PostController`/
 *     `PersonController` emitted here (with their GENERATED `GET /{id}/<relation>`
 *     traversal sub-resources delegating to the Exposed join helpers) are the artifacts
 *     under test, hosted UNMODIFIED.
 *  3. Compile every emitted `.kt` via kctfork (`inheritClassPath = true` → Spring +
 *     Exposed + serialization resolve from the test classpath).
 *  4. Provide the consumer persistence seam: the Kotlin controller embeds bare Exposed
 *     `transaction { }` against the thread-bound DEFAULT database. The harness connects
 *     Exposed to in-memory H2, creates the six GENERATED `<Entity>Table` schemas via
 *     `SchemaUtils.create`, and seeds them with raw JDBC INSERTs (the corpus is keyed by
 *     physical table name). The generated controller's own Exposed join + map runs
 *     genuinely end-to-end against it. The in-memory DB bootstrap is the ONLY hand-written
 *     piece — test scaffolding, not a conformance subject (real DB behavior is gated by
 *     persistence-conformance).
 *  5. Instantiate the generated controllers and host them on a Spring MockMvc
 *     `standaloneSetup` (no Spring Boot context, no socket).
 *
 * The harness is built ONCE; both controllers' MockMvc are rebuilt from a fresh H2
 * database in [reset] per scenario (isolation).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedM2mControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val seed: Map<String, List<Map<String, Any?>>>,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule()

    private val classLoader: ClassLoader
    private val postControllerClass: Class<*>
    private val personControllerClass: Class<*>

    /** The six generated `<Entity>Table` singletons, in dependency-safe create order. */
    private val tables: List<Table>

    private var postMvc: MockMvc? = null
    private var personMvc: MockMvc? = null
    private var activeContainer: PostgresContainer? = null

    init {
        // 1. Load the corpus metadata.
        val metaJson = corpusRoot.resolve("meta.json")
        val uri: URI = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-m2m-generated", listOf(uri))

        // 2. Generate entity data classes + Exposed tables + relation join helpers + filter
        //    allowlists + controllers, UNMODIFIED.
        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinNamesGenerator(),
            KotlinExposedTableGenerator(),
            KotlinRelationsGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            // Task 6 — free compile-level proof that <Entity>Names const val references
            // actually resolve; useNames is ignored by every other generator.
            g.setArgs(mapOf("outputDir" to srcDir.toString(), "useNames" to "true"))
            g.execute(loader)
        }

        // 3. Compile every emitted .kt against the test classpath.
        val sources = Files.walk(srcDir).use { stream ->
            stream.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .map { path ->
                    SourceFile.kotlin(srcDir.relativize(path).toString().replace('/', '_'), path.readText())
                }
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

        // 4. Load the compiled generated classes.
        classLoader = result.classLoader
        postControllerClass = classLoader.loadClass("$ENTITY_PKG.PostController")
        personControllerClass = classLoader.loadClass("$ENTITY_PKG.PersonController")
        // SchemaUtils.create resolves FK dependency order itself, but list the referenced
        // tables (posts/tags/people) before the junctions for readability.
        tables = listOf("PostTable", "TagTable", "PersonTable", "PostTagTable", "FollowTable", "FriendshipTable")
            .map { loadTable(it) }
    }

    /**
     * Rebuild both controllers' MockMvc against a fresh, freshly-seeded Postgres
     * database (one Testcontainers container per scenario, for isolation). Postgres
     * (not H2) is used here because the corpus is Postgres-only (ADR-0015) AND because
     * Postgres preserves the generated Exposed tables' quoted lowercase identifiers
     * (`"posts"`) — H2's default upper-folding diverges from the seed/schema identifiers.
     */
    fun reset() {
        activeContainer?.close()
        val pg = PostgresContainer()
        activeContainer = pg
        val db = Database.connect(pg.jdbcUrl, driver = "org.postgresql.Driver",
            user = pg.username, password = pg.password)
        transaction(db) {
            SchemaUtils.create(*tables.toTypedArray())
            seedRaw()
        }
        // FR-036: the generated controller ctors now also take a jakarta Validator.
        val validator = jakarta.validation.Validation.buildDefaultValidatorFactory().validator
        postMvc = standalone(postControllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java).newInstance(mapper, validator))
        personMvc = standalone(personControllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java).newInstance(mapper, validator))
    }

    /** Dispatch to the controller owning the source URL segment. */
    fun exchange(method: String, path: String): Response {
        val mvc = (if (path.startsWith("/api/posts")) postMvc else personMvc)
            ?: error("reset() must be called before exchange()")
        val res = mvc.perform(request(HttpMethod.valueOf(method), URI.create(path))).andReturn().response
        return Response(res.status, res.getContentAsString(StandardCharsets.UTF_8))
    }

    fun parseBody(body: String?): Any? =
        if (body.isNullOrEmpty()) null else mapper.readValue(body, Any::class.java)

    override fun close() { activeContainer?.close() }

    data class Response(val status: Int, val body: String)

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    /**
     * Seed the six generated tables with raw JDBC INSERTs against the open Exposed
     * transaction connection. Raw SQL (rather than typed Exposed inserts) keeps the
     * seam minimal + decoupled from each table object's column DSL.
     *
     * The physical COLUMN identifiers are derived from the corpus field names via
     * [camelToSnake] — mirroring the rule [KotlinExposedTableGenerator] applies when it
     * emits the schema — so a junction field like `postId` lands in the generated
     * `post_id` column. The values are read from the corpus seed by the original
     * (camelCase) key, then written to the snake_case physical column. Single-word
     * columns (`id`/`title`/`name`) are unaffected.
     */
    private fun seedRaw() {
        val conn = org.jetbrains.exposed.sql.transactions.TransactionManager
            .current().connection.connection as java.sql.Connection
        fun bind(ps: java.sql.PreparedStatement, idx: Int, v: Any?) {
            if (v is Number) ps.setLong(idx, v.toLong()) else ps.setObject(idx, v)
        }
        // table -> ordered field keys (camelCase, as in the corpus seed).
        fun exec(table: String, vararg fieldKeys: String) {
            val cols = fieldKeys.joinToString(", ") { "\"${camelToSnake(it)}\"" }
            val qs = fieldKeys.joinToString(", ") { "?" }
            conn.prepareStatement("INSERT INTO \"$table\" ($cols) VALUES ($qs)").use { ps ->
                for (r in M2mSeedAccess.rows(seed, table)) {
                    fieldKeys.forEachIndexed { i, k -> bind(ps, i + 1, r[k]) }
                    ps.executeUpdate()
                }
            }
        }
        exec("posts", "id", "title")
        exec("tags", "id", "name")
        exec("post_tags", "postId", "tagId")
        exec("people", "id", "name")
        exec("follows", "followerId", "followeeId")
        exec("friendships", "personAId", "personBId")
    }

    private fun loadTable(simpleName: String): Table =
        classLoader.loadClass("$ENTITY_PKG.$simpleName").getDeclaredField("INSTANCE").get(null) as Table

    private fun standalone(controller: Any): MockMvc {
        val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
        return MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()
    }

    private companion object {
        const val ENTITY_PKG = "acme.social"

        /**
         * Mirror of `KotlinGenUtil.camelToSnake` (which is `internal` to codegen-kotlin):
         * insert `_` at a lower/digit→Upper boundary or an Upper→Upper→lower acronym
         * boundary, then lowercase. `postId`→`post_id`, `personAId`→`person_a_id`,
         * `id`→`id`. Used only to address the GENERATED snake_case junction columns when
         * seeding; the generated schema is the source of truth.
         */
        fun camelToSnake(name: String): String {
            if (name.isEmpty()) return name
            val sb = StringBuilder(name.length + 4)
            for (i in name.indices) {
                val c = name[i]
                if (i > 0 && c.isUpperCase()) {
                    val prev = name[i - 1]
                    val next = if (i + 1 < name.length) name[i + 1] else null
                    if (prev.isLowerCase() || prev.isDigit() ||
                        (prev.isUpperCase() && next != null && next.isLowerCase())) {
                        sb.append('_')
                    }
                }
                sb.append(c.lowercaseChar())
            }
            return sb.toString()
        }
    }

    /** Seed-row accessor kept local so the `generated` package needs no cross-package import. */
    private object M2mSeedAccess {
        fun rows(seed: Map<String, List<Map<String, Any?>>>, table: String) = seed[table] ?: emptyList()
    }
}
