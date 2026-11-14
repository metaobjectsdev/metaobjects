package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

/**
 * A generated class DROPS an undeclared JSON key only where it is a create or update request body:
 * an entity with a generated write route, and a value object nested in one. A stored-proc argument
 * class, a response parser's decode target (ADR-0056) and a prompt payload are not request bodies, so
 * they keep the host mapper's strictness: a model reply carrying an extra key is still refused.
 *
 * Compiles the generated sources and binds JSON through a Jackson mapper with
 * FAIL_ON_UNKNOWN_PROPERTIES on, the setting a plain `ObjectMapper` ships with. Oracle: the
 * rule above and Jackson's documented `@JsonIgnoreProperties` semantics. The wrong behavior
 * rejected is a blanket annotation, which would let the `Reply` class bind a stray key.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinRequestBodyUnknownKeysTest {

    private val model = """{
      "metadata.root": { "package": "acme::body", "children": [
        { "object.value": { "name": "Stamp", "children": [
            { "field.string": { "name": "by", "@maxLength": 20 } },
            { "field.object": { "name": "where", "@objectRef": "Place" } }
        ] } },
        { "object.value": { "name": "Place", "children": [
            { "field.string": { "name": "city", "@maxLength": 20 } }
        ] } },
        { "object.value": { "name": "Reply", "children": [
            { "field.string": { "name": "text", "@maxLength": 100 } }
        ] } },
        { "object.entity": { "name": "Doc", "children": [
            { "source.rdb":   { "@table": "docs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@maxLength": 100 } },
            { "field.object": { "name": "stamp", "@objectRef": "Stamp", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `only a write route's entity and the value objects nested in it drop an undeclared key`() {
        val out = Files.createTempDirectory("kbody-")
        try {
            val loader = loadString("request-bodies", model)
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)

            val sources = Files.walk(out).filter { it.isRegularFile() }.sorted().toList()
                .map { SourceFile.kotlin(it.parent.relativize(it).toString().replace('/', '_'), it.readText()) }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)

            val strict = ObjectMapper().registerKotlinModule()
                .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true)
            val cl = result.classLoader

            // The entity and the value objects nested in it, one and two levels down: stray key dropped.
            assertNotNull(strict.readValue(
                """{"title":"t","isAdmin":true,"stamp":{"by":"b","zebra":1,"where":{"city":"c","zebra":2}}}""",
                cl.loadClass("acme.body.Doc")))

            // A value object nothing writable nests is not a request body: the strict mapper refuses it.
            assertFailsWith<UnrecognizedPropertyException> {
                strict.readValue("""{"text":"hi","zebra":1}""", cl.loadClass("acme.body.Reply"))
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
