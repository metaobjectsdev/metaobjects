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

    private val fixture = """{
      "metadata.root": { "package": "acme::widget", "children": [
        { "object.entity": { "name": "Widget", "children": [
            { "source.rdb":   { "@table": "widgets" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 40, "@filterable": true } },
            { "field.enum":   { "name": "color", "@values": ["RED", "GREEN", "BLUE"], "@filterable": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `generated controller filters a field-enum column (eq, like, in) over HTTP`() {
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
                "jdbc:h2:mem:enum_filter;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(widgetTable) }

            val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java).newInstance(mapper)
            val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
            val mvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

            fun exchange(method: String, path: String, body: Any?): Pair<Int, String> {
                val builder = request(HttpMethod.valueOf(method), URI.create(path))
                if (body != null) builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body))
                val res = mvc.perform(builder).andReturn().response
                return res.status to res.getContentAsString(StandardCharsets.UTF_8)
            }
            fun colorsOf(path: String): List<String> {
                val (status, body) = exchange("GET", path, null)
                assertEquals(200, status, "GET $path -> $body")
                @Suppress("UNCHECKED_CAST")
                val rows = mapper.readValue(body, List::class.java) as List<Map<String, Any?>>
                return rows.map { it["color"] as String }.sorted()
            }

            for (color in listOf("RED", "GREEN", "BLUE")) {
                val (status, body) = exchange("POST", "/api/widgets", mapOf("name" to "w-$color", "color" to color))
                assertEquals(201, status, "seed POST $color -> $body")
            }

            assertEquals(listOf("GREEN"), colorsOf("/api/widgets?filter[color][eq]=GREEN"))
            assertEquals(listOf("BLUE", "RED"), colorsOf("/api/widgets?filter[color][ne]=GREEN"))
            assertEquals(listOf("BLUE", "RED"), colorsOf("/api/widgets?filter[color][in]=RED,BLUE"))
            assertEquals(listOf("GREEN"), colorsOf("/api/widgets?filter[color][like]=%25EE%25")) // %EE% url-encoded
            assertEquals(listOf("BLUE", "GREEN", "RED"), colorsOf("/api/widgets"))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
