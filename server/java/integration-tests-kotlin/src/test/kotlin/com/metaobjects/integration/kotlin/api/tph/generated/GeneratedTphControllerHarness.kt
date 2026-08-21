package com.metaobjects.integration.kotlin.api.tph.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
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
 * FR-017 Tier 4/5 — host the GENERATED Kotlin Spring `@RestController` for the TPH corpus
 * (`Auth` base + `Bridge`/`Copay`/`PriorAuth` subtypes) over HTTP (in-process via Spring MockMvc)
 * and drive the polymorphic-CRUD scenarios against it.
 *
 * Mechanism (the SP-F generate→compile→load pattern, mirroring [com.metaobjects.integration.kotlin.api.generated.GeneratedAuthorControllerHarness]):
 *  1. Load `fixtures/api-contract-conformance/tph/meta.json`.
 *  2. Run the four codegen-kotlin generators — the emitted `AuthController` (polymorphic GET +
 *     per-subtype CRUD), the union `Auth` data class, and the union `AuthTable` are the artifacts
 *     under test, hosted UNMODIFIED.
 *  3. Compile every emitted `.kt` via kotlin-compile-testing (`inheritClassPath = true`).
 *  4. The consumer seam is an Exposed `Database` + the generated `AuthTable`: connect Exposed to a
 *     fresh in-memory H2 (PostgreSQL mode) per scenario, create the GENERATED table's schema, and
 *     seed the 3 corpus rows via a DIRECT Exposed insert against the GENERATED `AuthTable` — the
 *     ONLY hand-written piece, test scaffolding not a conformance subject.
 *  5. Host the controller on a Spring `MockMvc` `standaloneSetup`.
 *
 * Re-seeded per scenario (each TPH scenario mutates the single table).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedTphControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val seedRows: List<Map<String, Any?>>,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    private val controllerClass: Class<*>
    private val authTable: Table
    private val authTypeClass: Class<*>
    private val dbSeq = AtomicInteger(0)
    private var mockMvc: MockMvc? = null

    init {
        val metaJson = corpusRoot.resolve("tph/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-tph-generated", listOf(uri))

        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            g.setArgs(mapOf("outputDir" to srcDir.toString()))
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
        this.authTable = result.classLoader.loadClass(TABLE_FQCN).getDeclaredField("INSTANCE").get(null) as Table
        // `type` is the value-constrained enum discriminator (field.enum): the generated AuthTable's
        // `type` column is `Column<AuthType?>`. Resolve the enum reflectively to build seed rows.
        this.authTypeClass = result.classLoader.loadClass(TYPE_FQCN)
    }

    /** Rebuild a fresh in-memory H2 + controller + MockMvc, then seed via a direct Exposed insert. */
    fun reset() {
        val dbName = "tph_auth_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        transaction(db) { SchemaUtils.create(authTable) }

        // FR-036 Program B: the generated TPH controller ctor now takes the Spring-configured
        // ObjectMapper (per-field PATCH bind) + a jakarta Validator (present-value validation),
        // mirroring the vanilla generated-controller harness.
        val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
            .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
        val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
        mockMvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

        // #203/ADR-0045: seed via a DIRECT Exposed insert against the GENERATED AuthTable — NOT the
        // controller's per-subtype POST. The generated controller now STAMPS @autoSet columns on
        // create (autoCreatedAt/autoUpdatedAt := a freshly captured now()), so a POST-seeded row would
        // carry a 2026 now() instead of the seed's OLD 2000 sentinel, making the autoset-patch
        // `fieldsNotEqual` assertion vacuous (both columns would already diverge pre-PATCH, or worse,
        // coincide within the same second). A direct insert writes the seed's OLD
        // autoCreatedAt/autoUpdatedAt verbatim, so the later PATCH bumps autoUpdatedAt to now() while
        // autoCreatedAt stays OLD — the two robustly diverge.
        //
        // `id` is OMITTED so the auto-increment PK assigns 1..3 in the seed's own order (empty table),
        // exactly as the prior POST-seed did (1=Bridge, 2=Copay, 3=PriorAuth). Columns are matched by
        // NAME normalized (lowercase, underscores stripped) so the field camelCase (autoCreatedAt)
        // resolves to the generated snake_case physical column (auto_created_at) regardless of naming
        // strategy; typed inserts (not raw SQL) let Exposed handle all dialect identifier quoting.
        val colsByNorm = authTable.columns.associateBy { normalizeColName(it.name) }
        fun columnFor(field: String): Column<Any?> {
            @Suppress("UNCHECKED_CAST")
            return (colsByNorm[normalizeColName(field)]
                ?: error("generated AuthTable has no column for field '$field'")) as Column<Any?>
        }
        @Suppress("UNCHECKED_CAST")
        fun enumValueFor(name: String): Any = java.lang.Enum.valueOf(authTypeClass as Class<out Enum<*>>, name)

        transaction(db) {
            for (r in seedRows) {
                authTable.insert { stmt ->
                    stmt[columnFor("type")] = enumValueFor(r["type"] as String)
                    stmt[columnFor("reference")] = r["reference"] as String?
                    // FR-037 R1: the @mutability "writeOnce" column (declared on the TPH base),
                    // seeded verbatim so a later PATCH is observed to leave it alone.
                    stmt[columnFor("issuedCurrency")] = r["issuedCurrency"] as String?
                    stmt[columnFor("autoCreatedAt")] = parseSeedInstant(r["autoCreatedAt"] as String)
                    stmt[columnFor("autoUpdatedAt")] = parseSeedInstant(r["autoUpdatedAt"] as String)
                    stmt[columnFor("quantity")] = (r["quantity"] as? Number)?.toInt()
                    stmt[columnFor("copayAmount")] = (r["copayAmount"] as? String)?.let { java.math.BigDecimal(it) }
                    stmt[columnFor("approver")] = r["approver"] as String?
                }
            }
        }
    }

    /** Normalize a column/field name for camelCase↔snake_case-insensitive matching. */
    private fun normalizeColName(s: String): String = s.lowercase().replace("_", "")

    /**
     * Parse a corpus offset-less wall-clock timestamp (yyyy-MM-ddTHH:mm:ss) as a UTC [Instant] (the
     * instant wire contract). Used by the direct-insert seed to write the @autoSet sentinel values
     * verbatim.
     */
    private fun parseSeedInstant(raw: String): Instant {
        val s = if (raw.endsWith("Z") || raw.contains("+")) raw else raw + "Z"
        return Instant.parse(s)
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
        const val ENTITY_PKG = "acme.auth"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.AuthController"
        const val TABLE_FQCN = "$ENTITY_PKG.AuthTable"
        const val TYPE_FQCN = "$ENTITY_PKG.AuthType"
    }
}
