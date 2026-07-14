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
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * FR-035 present-key PATCH edge cases on the GENERATED Kotlin Spring controller.
 *
 *  - **FIX A** — a writable entity whose only non-PK columns are object / map / jsonb-open-bag
 *    (an EMPTY patch-settable set) must still COMPILE under `allWarningsAsErrors`: the controller
 *    emits NO `ObjectMapper` ctor param and NO `TypeReference` import (both would be unused →
 *    the whole module compile fails on `-Werror`), and NO empty Exposed `update{}` (which throws).
 *  - **FIX B** — a present value whose JSON shape cannot bind to its column's Kotlin type (an
 *    object for a `String` column) is a 400, not a 500 (the create `@Valid` path 400s it too).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class PatchTristateEdgeCasesTest {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule()

    private fun generate(name: String, fixture: String, outDir: Path) {
        val loader = loadString(name, fixture)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            g.setArgs(mapOf("outputDir" to outDir.toString()))
            g.execute(loader)
        }
    }

    private fun compile(outDir: Path, werror: Boolean) =
        KotlinCompilation().apply {
            sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                .toList()
            inheritClassPath = true
            allWarningsAsErrors = werror
            messageOutputStream = System.out
        }.compile()

    // FIX A: PK + only a jsonb open-bag column → empty patch-settable set.
    @Test
    fun `no-settable-field entity controller compiles under allWarningsAsErrors`() {
        val outDir = Files.createTempDirectory("patch-nosettable-")
        try {
            generate("nosettable", """{
              "metadata.root": { "package": "acme::cfg", "children": [
                { "object.entity": { "name": "Settings", "children": [
                    { "source.rdb":   { "@table": "settings" } },
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "blob", "@dbColumnType": "jsonb" } },
                    { "identity.primary": { "@fields": "id", "@generation": "increment" } }
                ] } }
              ] }
            }""".trimIndent(), outDir)

            // The unused-symbol check `-Werror` would enforce, done as a source assertion so it
            // isn't masked by unrelated deprecation warnings in the generated list handler: an
            // empty patch-settable set must emit NO ObjectMapper ctor param and NO TypeReference
            // import (either would be an unused symbol → a real consumer's -Werror build fails).
            val src = Files.readString(outDir.resolve("acme/cfg/SettingsController.kt"))
            assertTrue("ObjectMapper" !in src,
                "a no-settable-field controller must not take an ObjectMapper ctor param:\n$src")
            assertTrue("TypeReference" !in src,
                "a no-settable-field controller must not import TypeReference:\n$src")

            // And it must still compile (no empty Exposed update{}, no dangling references).
            val result = compile(outDir, werror = false)
            assertTrue(result.exitCode == KotlinCompilation.ExitCode.OK,
                "a no-settable-field controller must compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // FIX B: a JSON object for a String column → 400, not 500.
    @Test
    fun `patch with a type-mismatched present value is 400 not 500`() {
        val outDir = Files.createTempDirectory("patch-mismatch-")
        try {
            generate("mismatch", """{
              "metadata.root": { "package": "acme::doc", "children": [
                { "object.entity": { "name": "Doc", "children": [
                    { "source.rdb":   { "@table": "docs" } },
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "name", "@maxLength": 80, "@required": true } },
                    { "identity.primary": { "@fields": "id", "@generation": "increment" } }
                ] } }
              ] }
            }""".trimIndent(), outDir)

            val result = compile(outDir, werror = false)
            assertTrue(result.exitCode == KotlinCompilation.ExitCode.OK,
                "Doc controller failed to compile:\n${result.messages}")
            val cl = result.classLoader
            val controllerClass = cl.loadClass("acme.doc.DocController")
            val docTable = cl.loadClass("acme.doc.DocTable").getDeclaredField("INSTANCE").get(null) as Table

            val db = Database.connect(
                "jdbc:h2:mem:patch_mismatch;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
            transaction(db) { SchemaUtils.create(docTable) }

            // FR-036: the generated controller ctor now also takes a jakarta Validator.
            val controller = controllerClass.getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
                .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
            val converter = MappingJackson2HttpMessageConverter().apply { objectMapper = mapper }
            val mvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build()

            fun exchange(method: String, path: String, body: Any?): Pair<Int, String> {
                val builder = request(HttpMethod.valueOf(method), URI.create(path))
                if (body != null) builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body))
                val res = mvc.perform(builder).andReturn().response
                return res.status to res.getContentAsString(StandardCharsets.UTF_8)
            }

            assertEquals(201, exchange("POST", "/api/docs", mapOf("name" to "hello")).first)
            // An OBJECT for the String `name` column cannot bind → 400 (not a 500 from inside the tx).
            val (status, body) = exchange("PATCH", "/api/docs/1", mapOf("name" to mapOf("nested" to 1)))
            assertEquals(400, status, "a type-mismatched present value must be 400; got $status $body")
            assertTrue("validation" in body, "expected the validation error envelope; got $body")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
