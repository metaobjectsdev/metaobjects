package com.metaobjects.integration.kotlin.api.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * A generated Kotlin Spring controller must FILTER on a `@filterable field.decimal` and a
 * `@filterable field.float` column: compile AND execute, on an ordinary writable entity.
 *
 * The filter pipeline coerced both with the Double coercer, and the dispatch arm then cast
 * the value to the column's own type (`p.value as BigDecimal`, `p.value as Float`). A boxed
 * Double is neither, so every such filter threw `ClassCastException` out of the handler, a
 * 500 on a request the allowlist had admitted. Each subtype now has its own coercer.
 *
 * Drives the GENERATED controller over MockMvc against H2 (PostgreSQL mode), on the pattern
 * of [EnumFilterControllerRunTest]. The model is the committed snapshot fixture
 * `codegen-kotlin/src/test/resources/fixtures/entity-with-decimal-float-filter`, restated
 * here because a fixture of another module is not on this one's path.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class DecimalFloatFilterControllerRunTest {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule()

    private val fixture = """{
      "metadata.root": { "package": "acme::catalog", "children": [
        { "object.entity": { "name": "Product", "children": [
            { "source.rdb":    { "@table": "products" } },
            { "field.long":    { "name": "id" } },
            { "field.string":  { "name": "name", "@maxLength": 40, "@required": true } },
            { "field.decimal": { "name": "price", "@precision": 10, "@scale": 2, "@filterable": true } },
            { "field.float":   { "name": "rating", "@filterable": true } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** name, price, rating. `unrated` has neither a price nor a rating. */
    private val seed = listOf(
        mapOf("name" to "pen", "price" to "1.50", "rating" to 2.5),
        mapOf("name" to "book", "price" to "12.25", "rating" to 4.0),
        mapOf("name" to "lamp", "price" to "40.00", "rating" to 4.5),
        mapOf("name" to "unrated"),
    )

    @Test
    fun `generated controller filters a field-decimal column numerically over HTTP`() = withProductController("decimal_filter") { namesAt ->
        assertEquals(listOf("book", "lamp"), namesAt("/api/products?filter[price][gt]=1.5"))
        assertEquals(listOf("book", "lamp", "pen"), namesAt("/api/products?filter[price][gte]=1.5"))
        // Numeric, not textual: as text "12.25" sorts before "9".
        assertEquals(listOf("pen"), namesAt("/api/products?filter[price][lt]=9"))
        assertEquals(listOf("book"), namesAt("/api/products?filter[price][eq]=12.25"))
        assertEquals(listOf("lamp", "pen"), namesAt("/api/products?filter[price][ne]=12.25"))
        assertEquals(listOf("lamp", "pen"), namesAt("/api/products?filter[price][in]=1.50,40"))
        assertEquals(listOf("unrated"), namesAt("/api/products?filter[price][isNull]=true"))
    }

    @Test
    fun `generated controller filters a field-float column numerically over HTTP`() = withProductController("float_filter") { namesAt ->
        assertEquals(listOf("book", "lamp"), namesAt("/api/products?filter[rating][gt]=2.5"))
        assertEquals(listOf("pen"), namesAt("/api/products?filter[rating][lte]=2.5"))
        assertEquals(listOf("lamp"), namesAt("/api/products?filter[rating][eq]=4.5"))
        assertEquals(listOf("book", "pen"), namesAt("/api/products?filter[rating][in]=2.5,4"))
        assertEquals(listOf("unrated"), namesAt("/api/products?filter[rating][isNull]=true"))
    }

    @Test
    fun `a value that is not a number is a 400 naming the field`() = withProductController("bad_number") { _, exchange ->
        for (field in listOf("price", "rating")) {
            val (status, body) = exchange("/api/products?filter[$field][gt]=abc")
            assertEquals(400, status, body)
            assertEquals(mapOf("error" to "invalid_filter_value", "field" to field), mapper.readValue(body, Map::class.java))
        }
    }

    private fun withProductController(dbName: String, block: (namesAt: (String) -> List<String>) -> Unit) =
        withProductController(dbName) { namesAt, _ -> block(namesAt) }

    /** Generate, compile, load and seed the Product controller. */
    private fun withProductController(
        dbName: String,
        block: (namesAt: (String) -> List<String>, exchange: (String) -> Pair<Int, String>) -> Unit,
    ) {
        val outDir = Files.createTempDirectory("decimal-float-filter-")
        try {
            val loader = loadString("decimal-float-filter", fixture)
            for (g in listOf(
                KotlinEntityGenerator(),
                KotlinExposedTableGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(),
            )) {
                g.setArgs(mapOf("outputDir" to outDir.toString()))
                g.execute(loader)
            }

            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                .toList()
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated controller with a @filterable decimal and float failed to compile:\n${result.messages}")

            val cl = result.classLoader
            val controllerClass = cl.loadClass("acme.catalog.ProductController")
            val table = cl.loadClass("acme.catalog.ProductTable").getDeclaredField("INSTANCE").get(null) as Table

            val db = Database.connect(
                "jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(table) }

            val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
                .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
            val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
            val mvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

            fun send(method: String, uri: URI, body: Any?): Pair<Int, String> {
                val builder = request(HttpMethod.valueOf(method), uri)
                if (body != null) builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body))
                val res = mvc.perform(builder).andReturn().response
                return res.status to res.getContentAsString(StandardCharsets.UTF_8)
            }

            for (row in seed) {
                val (status, body) = send("POST", URI.create("/api/products"), row)
                assertEquals(201, status, "seed POST ${row["name"]} -> $body")
            }

            val exchange = { path: String -> send("GET", URI.create(path), null) }
            val namesAt = { path: String ->
                val (status, body) = exchange(path)
                assertEquals(200, status, "GET $path -> $body")
                @Suppress("UNCHECKED_CAST")
                (mapper.readValue(body, List::class.java) as List<Map<String, Any?>>).map { it["name"] as String }.sorted()
            }
            block(namesAt, exchange)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
