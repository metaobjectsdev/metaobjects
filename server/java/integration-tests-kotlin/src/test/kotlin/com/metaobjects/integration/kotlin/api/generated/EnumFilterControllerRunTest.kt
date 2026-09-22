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
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #179 regression: a generated Kotlin Spring controller must FILTER on a `@filterable field.enum`
 * column — compile AND execute. The Exposed column is typed `Column<Enum>`, so the fix compares it
 * by its stored string via `CAST(col AS text)` (the FR-009 string band: eq/ne/in/like/isNull). Before
 * the fix the controller emitted `col eq (p.value as <BareEnum>)` — an unresolved type + a
 * String→enum ClassCastException.
 *
 * This drives the GENERATED controller over MockMvc against H2 (PostgreSQL mode) — the same
 * generate→compile→load→seed→query pattern as [GeneratedAuthorControllerHarness] — so it proves the
 * emitted `castTo<String>(...)` SQL both compiles and returns the right rows.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class EnumFilterControllerRunTest {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule()

    private companion object {
        /** The int-backed `size` each seeded colour carries. */
        val SIZE_OF = mapOf("RED" to "S", "GREEN" to "M", "BLUE" to "L")
    }

    private val fixture = """{
      "metadata.root": { "package": "acme::widget", "children": [
        { "object.entity": { "name": "Widget", "children": [
            { "source.rdb":   { "@table": "widgets" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 40, "@filterable": true } },
            { "field.enum":   { "name": "color", "@values": ["RED", "GREEN", "BLUE"], "@filterable": true } },
            { "field.enum":   { "name": "size", "@values": ["S", "M", "L"], "@intValueMap": { "S": 1, "M": 5, "L": 9 }, "@filterable": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `generated controller filters a field-enum column (eq, like, in) over HTTP`() = withWidgetController("enum_filter") { exchange ->
        fun colorsAt(path: String): List<String> = colorsOf(exchange("GET", URI.create(path), null))

        assertEquals(listOf("GREEN"), colorsAt("/api/widgets?filter[color][eq]=GREEN"))
        assertEquals(listOf("BLUE", "RED"), colorsAt("/api/widgets?filter[color][ne]=GREEN"))
        assertEquals(listOf("BLUE", "RED"), colorsAt("/api/widgets?filter[color][in]=RED,BLUE"))
        assertEquals(listOf("GREEN"), colorsAt("/api/widgets?filter[color][like]=%25EE%25")) // %EE% url-encoded
        assertEquals(listOf("BLUE", "GREEN", "RED"), colorsAt("/api/widgets"))
    }

    /**
     * An INT-BACKED enum (`@intValueMap`) stores the member's declared integer, and the
     * generated filter compared the column as TEXT against the member symbol — '5' against
     * 'M' — so eq/in matched nothing and ne matched everything, each with a 200.
     */
    @Test
    fun `generated controller filters an int-backed enum column by member symbol`() = withWidgetController("int_enum_filter") { exchange ->
        fun colorsAt(path: String): List<String> = colorsOf(exchange("GET", URI.create(path), null))

        assertEquals(listOf("GREEN"), colorsAt("/api/widgets?filter[size][eq]=M"))
        assertEquals(listOf("BLUE", "RED"), colorsAt("/api/widgets?filter[size][ne]=M"))
        assertEquals(listOf("BLUE", "RED"), colorsAt("/api/widgets?filter[size][in]=S,L"))
        // A symbol that names no member matches no row.
        assertEquals(emptyList<String>(), colorsAt("/api/widgets?filter[size][eq]=XL"))
    }

    /**
     * A browser sends a typed `%` unencoded, so `?filter[name][like]=w-G%` arrives with a
     * malformed escape. Tomcat then DROPS that parameter from the servlet parameter map
     * ("Character decoding failed ... has been ignored"), and a controller reading the map
     * returned every row with a 200. MockMvc parses parameters itself, so the request here is
     * built the way Tomcat hands it over: the raw query string present, the parameter absent.
     */
    @Test
    fun `a raw percent in a like value still filters, as Tomcat delivers it`() = withWidgetController("raw_percent") { exchange ->
        fun colorsOfRaw(rawQuery: String): List<String> =
            colorsOf(exchange("GET", URI.create("/api/widgets"), rawQuery))

        assertEquals(listOf("GREEN"), colorsOfRaw("filter[name][like]=w-G%"))
        // the stray `%` must not swallow the `&` that starts the next filter
        assertEquals(listOf("BLUE", "GREEN"), colorsOfRaw("filter[name][like]=w-%&filter[color][in]=BLUE,GREEN"))
    }

    private fun colorsOf(response: Pair<Int, String>): List<String> {
        val (status, body) = response
        assertEquals(200, status, "GET -> $body")
        @Suppress("UNCHECKED_CAST")
        val rows = mapper.readValue(body, List::class.java) as List<Map<String, Any?>>
        return rows.map { it["color"] as String }.sorted()
    }

    /** Generate, compile, load and seed the Widget controller; [block] gets `exchange(method, uri, rawQuery?)`. */
    private fun withWidgetController(
        dbName: String,
        block: (exchange: (String, URI, String?) -> Pair<Int, String>) -> Unit,
    ) {
        val outDir = Files.createTempDirectory("enum-filter-")
        try {
            val loader = loadString("enum-filter", fixture)
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
                "generated controller with a @filterable enum failed to compile:\n${result.messages}")

            val cl = result.classLoader
            val controllerClass = cl.loadClass("acme.widget.WidgetController")
            val widgetTable = cl.loadClass("acme.widget.WidgetTable")
                .getDeclaredField("INSTANCE").get(null) as Table

            val db = Database.connect(
                "jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(widgetTable) }

            // FR-036: the generated controller ctor now also takes a jakarta Validator.
            val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
                .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
            val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
            val mvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

            fun send(method: String, uri: URI, body: Any?, rawQuery: String?): Pair<Int, String> {
                val builder = request(HttpMethod.valueOf(method), uri)
                if (body != null) builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body))
                if (rawQuery != null) builder.with { it.queryString = rawQuery; it }
                val res = mvc.perform(builder).andReturn().response
                return res.status to res.getContentAsString(StandardCharsets.UTF_8)
            }

            for (color in listOf("RED", "GREEN", "BLUE")) {
                val (status, body) = send("POST", URI.create("/api/widgets"), mapOf("name" to "w-$color", "color" to color, "size" to SIZE_OF.getValue(color)), null)
                assertEquals(201, status, "seed POST $color -> $body")
            }

            block { method, uri, rawQuery -> send(method, uri, null, rawQuery) }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
