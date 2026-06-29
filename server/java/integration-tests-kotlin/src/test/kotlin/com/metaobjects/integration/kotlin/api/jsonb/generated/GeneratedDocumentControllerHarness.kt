package com.metaobjects.integration.kotlin.api.jsonb.generated

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * Issue #98 — host the GENERATED Kotlin Spring `@RestController` for the `jsonb/`
 * corpus `Document` entity over HTTP (in-process via Spring MockMvc) and drive the
 * jsonb open-bag api-contract scenario against it.
 *
 * Mechanism (the SP-F generate→compile→load pattern, mirroring the base Kotlin
 * `GeneratedAuthorControllerHarness`):
 *  1. Load `fixtures/api-contract-conformance/jsonb/meta.json`.
 *  2. Run the four codegen-kotlin generators — [KotlinEntityGenerator] (the
 *     `@Serializable Document` data class = controller request/response body, with
 *     `payload: JsonElement?` per #98), [KotlinExposedTableGenerator] (`DocumentTable`,
 *     `payload` = a real `JSONB` column), [KotlinFilterAllowlistGenerator], and
 *     [KotlinSpringControllerGenerator] (`DocumentController`, hosted UNMODIFIED).
 *  3. Compile every emitted `.kt` via kctfork (`inheritClassPath = true`).
 *  4. Provide the consumer persistence seam: the controller embeds bare Exposed
 *     `transaction { }` against the thread-bound DEFAULT database. Postgres
 *     (Testcontainers) — NOT H2 — is used because the open bag is a real `JSONB`
 *     column (H2 has no native JSONB) and the corpus is Postgres-only (ADR-0015).
 *  5. Provide the consumer SERIALIZATION seam: the open-bag field is a kotlinx
 *     `JsonElement`, which NEITHER of Spring's built-in JSON converters handles out of
 *     the box — vanilla Jackson can't construct a `JsonElement` (a sealed type), and
 *     Spring's `KotlinSerializationJsonHttpMessageConverter` refuses any body whose
 *     serializer is polymorphic (a `JsonElement` is a sealed polymorphic hierarchy →
 *     HTTP 415). So the consumer must wire a `JsonElement` codec. Here that seam is a
 *     tiny Jackson [SimpleModule] (writeRawValue of the canonical-JSON `toString()`;
 *     `parseToJsonElement` on read) on the same Jackson converter the scalar `Author`/
 *     `m2m` lanes use — test scaffolding, like the DB bootstrap, not a change to the
 *     generated artifact. The open bag round-trips object-in / object-out, never a
 *     JSON-encoded string.
 *
 * Re-seeded per scenario (fresh Postgres container) for isolation.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedDocumentControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val seedRows: List<Map<String, Any?>>,
) : AutoCloseable {

    /** Jackson mapper used by BOTH the server message converter and the harness-side
     *  request-build / response-parse. The kotlin module reads the generated data classes;
     *  the [jsonElementModule] bridges the open-bag `JsonElement` ↔ JSON (the consumer
     *  serialization seam). */
    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(jsonElementModule())

    private val classLoader: ClassLoader
    private val controllerClass: Class<*>
    private val documentTable: Table

    private var mockMvc: MockMvc? = null
    private var activeContainer: PostgresContainer? = null

    init {
        // 1. Load the corpus metadata.
        val metaJson = corpusRoot.resolve("meta.json")
        val uri: URI = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-jsonb-generated", listOf(uri))

        // 2. Run the four generators — emit the GENERATED controller + DTO + table + filter
        //    allowlist, UNMODIFIED.
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
        this.classLoader = result.classLoader
        this.controllerClass = classLoader.loadClass(CONTROLLER_FQCN)
        this.documentTable = classLoader.loadClass(TABLE_FQCN)
            .getDeclaredField("INSTANCE").get(null) as Table
    }

    /**
     * Re-seed for a scenario: a fresh Postgres container + the generated `DocumentTable`
     * schema (a real JSONB column) + the 2 corpus documents loaded through the
     * GENERATED controller's OWN create path (POST /api/documents) — empty table →
     * ids 1,2, so the first scenario POST deterministically lands at id 3.
     */
    fun reset(seed: Boolean) {
        activeContainer?.close()
        val pg = PostgresContainer()
        activeContainer = pg
        val db = Database.connect(pg.jdbcUrl, driver = "org.postgresql.Driver",
            user = pg.username, password = pg.password)
        transaction(db) { SchemaUtils.create(documentTable) }

        mockMvc = standalone(controllerClass.getDeclaredConstructor().newInstance())

        if (seed) {
            for (r in seedRows) {
                // Omit `id` (server-assigned). payload is the seed row's JSON object.
                val body = linkedMapOf<String, Any?>(
                    "title" to r["title"],
                    "payload" to r["payload"],
                )
                val res = exchange("POST", "/api/documents", body)
                check(res.status == 201) { "seed POST failed (status ${res.status}); body: ${res.body}" }
            }
        }
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
        activeContainer?.close()
    }

    /** HTTP status + raw body string. */
    data class Response(val status: Int, val body: String)

    private fun standalone(controller: Any): MockMvc =
        MockMvcBuilders.standaloneSetup(controller)
            .setMessageConverters(MappingJackson2HttpMessageConverter().apply { objectMapper = mapper })
            .build()

    private companion object {
        const val ENTITY_PKG = "acme.store"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.DocumentController"
        const val TABLE_FQCN = "$ENTITY_PKG.DocumentTable"

        /**
         * A Jackson module bridging kotlinx `JsonElement` ↔ JSON — the consumer's
         * serialization seam for the open-bag field. Serialize: write the canonical-JSON
         * `JsonElement.toString()` raw (object stays an object). Deserialize: read the JSON
         * subtree and `Json.parseToJsonElement` it.
         */
        fun jsonElementModule(): SimpleModule {
            val module = SimpleModule("JsonElementModule")
            module.addSerializer(JsonElement::class.java, object : JsonSerializer<JsonElement>() {
                override fun serialize(value: JsonElement, gen: JsonGenerator, serializers: SerializerProvider) {
                    gen.writeRawValue(value.toString())
                }
            })
            module.addDeserializer(JsonElement::class.java, object : JsonDeserializer<JsonElement>() {
                override fun deserialize(p: JsonParser, ctxt: DeserializationContext): JsonElement {
                    val node = p.readValueAsTree<JsonNode>()
                    return Json.parseToJsonElement(node.toString())
                }
            })
            return module
        }
    }
}
