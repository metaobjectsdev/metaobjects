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
import java.util.Locale
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
 *     seed the 3 corpus rows through the controller's OWN per-subtype POST path (discriminator
 *     injected from the URL) — the ONLY hand-written piece, test scaffolding not a conformance subject.
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
    }

    /** Rebuild a fresh in-memory H2 + controller + MockMvc, then seed via the controller's POST path. */
    fun reset() {
        val dbName = "tph_auth_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        transaction(db) { SchemaUtils.create(authTable) }

        val controller = controllerClass.getDeclaredConstructor().newInstance()
        val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
        mockMvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

        // Seed the 3 rows through the controller's OWN per-subtype POST (discriminator from the URL),
        // in order, so the auto-increment PK reproduces the corpus ids (1=Bridge, 2=Copay, 3=PriorAuth).
        for (r in seedRows) {
            val type = (r["type"] as String).lowercase(Locale.ROOT)
            // Body = every column except id + type, dropping nulls (the per-subtype create only
            // writes its own columns; the discriminator comes from the URL).
            val body = r.filterKeys { it != "id" && it != "type" }.filterValues { it != null }
            val res = exchange("POST", "/api/auths/$type", body)
            check(res.status == 201) { "seed POST /api/auths/$type failed (status ${res.status}); body: ${res.body}" }
        }
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
    }
}
