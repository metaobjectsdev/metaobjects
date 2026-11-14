package com.metaobjects.integration.kotlin.api.generated

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.config.ApiSettings
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.integration.kotlin.api.TomcatHost
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * `api.unknownFields`: a generated Kotlin create, PUT and PATCH answers an undeclared body key the same way
 * whatever the host's `ObjectMapper` does with an unknown property. The keys are read off the raw body before
 * it is bound, so a mapper with `FAIL_ON_UNKNOWN_PROPERTIES` on and one with it off give identical answers under
 * both `reject` and `drop`, over a real HTTP exchange (embedded Tomcat, in-memory H2), plain entity and TPH.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
internal class UnknownFieldsHostMapperIndependenceTest {

    @TempDir
    lateinit var tmp: Path

    private val dbSeq = AtomicInteger(0)

    /** One generated and compiled controller pair for a given `api.unknownFields` setting. */
    private inner class Built(api: ApiSettings, name: String) {
        val thingController: Class<*>
        val authController: Class<*>
        val tables: List<Table>

        init {
            val metaFile = tmp.resolve("$name-meta.json")
            Files.writeString(metaFile, META)
            val uri = URIHelper.toURI("model:file:" + metaFile.toAbsolutePath().toString().replace('\\', '/'))
            val loader = loadUris("unknown-fields-$name", listOf(uri))
            loader.root.apiSettings = api
            val srcDir = tmp.resolve("gen-$name")
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
                    .map { SourceFile.kotlin(srcDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                    .toList()
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            check(result.exitCode == KotlinCompilation.ExitCode.OK) { "generated Kotlin failed to compile:\n${result.messages}" }
            thingController = result.classLoader.loadClass("acme.thing.ThingController")
            authController = result.classLoader.loadClass("acme.thing.AuthController")
            tables = listOf("acme.thing.ThingTable", "acme.thing.AuthTable").map {
                result.classLoader.loadClass(it).getDeclaredField("INSTANCE").get(null) as Table
            }
        }

        /** The answers of [requests] (method, path, body) through a host whose mapper fails on unknown properties or not. */
        fun answers(failOnUnknown: Boolean, requests: List<Triple<String, String, String>>): List<String> {
            val mapper = ObjectMapper()
                .registerKotlinModule()
                .registerModule(JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, failOnUnknown)
            val db = Database.connect("jdbc:h2:mem:unknown_${dbSeq.incrementAndGet()};DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(*tables.toTypedArray()) }
            val validator = jakarta.validation.Validation.buildDefaultValidatorFactory().validator
            val things = thingController.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java).newInstance(mapper, validator)
            val auths = authController.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java).newInstance(mapper, validator)
            TomcatHost.start(mapper, things, auths).use { host ->
                return requests.map { (method, path, body) ->
                    val res = host.exchange(method, path, body)
                    // A refusal is compared in full; any other answer by its status alone.
                    if (res.status == 400) "400 ${res.body}" else res.status.toString()
                }
            }
        }
    }

    /** The same requests through a failing and a tolerant mapper: one list of answers. */
    private fun same(b: Built, requests: List<Triple<String, String, String>>): List<String> {
        val strict = b.answers(true, requests)
        val lax = b.answers(false, requests)
        assertEquals(strict, lax, "the host mapper must not change the answer")
        return strict
    }

    @Test
    fun rejectAnswersUnknownFieldsTheSameUnderEveryMapper() {
        val b = Built(ApiSettings.DEFAULT, "reject")
        val refusal = "400 {\"error\":\"unknown_fields\",\"fields\":[\"isAdmin\",\"zebra\"]}"
        val answers = same(
            b,
            listOf(
                // create, PUT and PATCH, plain and TPH: every undeclared key listed in code-point order
                Triple("POST", "/api/things", """{"title":"t","zebra":1,"isAdmin":true}"""),
                Triple("PUT", "/api/things/1", """{"title":"t","zebra":1,"isAdmin":true}"""),
                Triple("PATCH", "/api/things/1", """{"title":"t","zebra":1,"isAdmin":true}"""),
                Triple("POST", "/api/auths/bridge", """{"quantity":1,"zebra":1,"isAdmin":true}"""),
                Triple("PATCH", "/api/auths/bridge/1", """{"quantity":1,"zebra":1,"isAdmin":true}"""),
                // declared keys the client may not set stay known (dropped, not refused), and so does a sibling's column
                Triple("POST", "/api/things", """{"id":9,"title":"t","role":"admin"}"""),
                Triple("POST", "/api/auths/bridge", """{"quantity":1,"approver":"x"}"""),
            ),
        )
        assertEquals(List(5) { refusal } + listOf("201", "201"), answers)
    }

    @Test
    fun dropIgnoresUnknownFieldsTheSameUnderEveryMapper() {
        val b = Built(ApiSettings(null, ApiSettings.UnknownFields.DROP), "drop")
        val answers = same(
            b,
            listOf(
                Triple("POST", "/api/things", """{"title":"t","zebra":1,"isAdmin":true}"""),
                Triple("PATCH", "/api/things/1", """{"title":"u","zebra":1}"""),
                Triple("POST", "/api/auths/bridge", """{"quantity":1,"zebra":1}"""),
                Triple("PATCH", "/api/auths/bridge/1", """{"quantity":2,"zebra":1}"""),
            ),
        )
        assertEquals(listOf("201", "200", "201", "200"), answers)
    }

    @Test
    fun aBodyThatIsNotAnObjectIsLeftToTheExistingHandling() {
        val b = Built(ApiSettings.DEFAULT, "nonobject")
        val answers = same(b, listOf(Triple("POST", "/api/things", "[1, 2]")))
        assertEquals(1, answers.size)
        check(answers[0].startsWith("400 ") && "unknown_fields" !in answers[0]) { answers[0] }
    }

    private companion object {
        val META = """
            { "metadata.root": { "package": "acme::thing", "children": [
              { "object.entity": { "name": "Thing", "children": [
                { "source.rdb": { "@table": "things" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "title", "@required": true } },
                { "field.string": { "name": "role", "@mutability": "readOnly" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
              ] } },
              { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb": { "@table": "auths" } },
                { "field.enum": { "name": "type", "@values": ["Bridge", "Copay"] } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
              ] } },
              { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge",
                "children": [ { "field.int": { "name": "quantity" } } ] } },
              { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay",
                "children": [ { "field.string": { "name": "approver" } } ] } }
            ] } }
        """.trimIndent()
    }
}
