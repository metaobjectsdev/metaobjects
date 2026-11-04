package com.metaobjects.integration.kotlin.api.tph.generated

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
import org.springframework.http.MediaType
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * A TPH subtype's cross-field validators hold on its per-subtype POST. That handler binds the
 * annotation-free union body and validates it per property against `<Sub>Validation`, which never
 * reaches the subtype data class's class-level `@AssertTrue` properties, so the generated controller
 * evaluates the rules itself. The oracle is the validator's declared meaning (FR-036's CHECK
 * semantics): `requiredWhen(note, kind = BIRTH)` rejects a BIRTH body with no note and accepts every
 * other body; a rule gated on the discriminator reads the route's pinned value, so it applies even
 * when the body omits the discriminator. Drives the generated controller over MockMvc against H2.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class TphCrossFieldControllerRunTest {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule()

    private val fixture = """{
      "metadata.root": { "package": "acme::ev", "children": [
        { "object.entity": { "name": "Event", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "events" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Birth", "Death"] } },
            { "field.string": { "name": "kind", "@maxLength": 20 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BirthEvent", "extends": "Event", "@discriminatorValue": "Birth", "children": [
            { "field.string": { "name": "note", "@maxLength": 40 } },
            { "validator.requiredWhen": { "name": "birthNeedsNote", "@field": "note", "@when": "kind", "@equals": "BIRTH" } }
        ] } },
        { "object.entity": { "name": "DeathEvent", "extends": "Event", "@discriminatorValue": "Death", "children": [
            { "field.string": { "name": "subject", "@maxLength": 40 } },
            { "validator.requiredWhen": { "name": "deathNeedsSubject", "@field": "subject", "@when": "type", "@equals": "Death" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `per-subtype create enforces the subtype's cross-field rules`() {
        val outDir = Files.createTempDirectory("tph-cross-field-")
        try {
            val loader = loadString("tph-cross-field", fixture)
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
                "generated TPH controller with cross-field rules failed to compile:\n${result.messages}")

            val cl = result.classLoader
            val table = cl.loadClass("acme.ev.EventTable").getDeclaredField("INSTANCE").get(null) as Table
            val db = Database.connect("jdbc:h2:mem:tph_cross_field;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(table) }
            val controller = cl.loadClass("acme.ev.EventController")
                .getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
                .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
            val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
            val mvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

            fun status(path: String, body: Map<String, Any?>): Int {
                val res = mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body)))
                    .andReturn().response
                return res.status
            }

            assertEquals(400, status("/api/events/birth", mapOf("kind" to "BIRTH")))
            assertEquals(201, status("/api/events/birth", mapOf("kind" to "BIRTH", "note" to "n")))
            assertEquals(201, status("/api/events/birth", mapOf("kind" to "OTHER")))
            assertEquals(201, status("/api/events/birth", emptyMap()))

            assertEquals(400, status("/api/events/death", emptyMap()))
            assertEquals(201, status("/api/events/death", mapOf("subject" to "s")))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
