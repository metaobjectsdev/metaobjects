package com.metaobjects.generator.kotlin.writer

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.writer.CodeWriter
import com.metaobjects.generator.writer.Group
import com.metaobjects.generator.writer.WriterException
import com.metaobjects.generator.writer.WriterOptions
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.name
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * Runs `fixtures/writer-conformance/` against the Kotlin writer (spec/code-writer.md). `core`
 * cases run on the shared [CodeWriter] core with the options the case states; `kotlin` cases run
 * on [KotlinWriter] with its own defaults unless the case overrides them. A case of another
 * dialect belongs to that port's writer and is skipped here by name.
 */
class KotlinWriterConformanceTest {

    private val cases: Path = Path.of(System.getProperty("user.dir"))
        .resolve("../../../fixtures/writer-conformance/cases").normalize()

    private fun corpus(): List<Pair<String, JsonNode>> =
        Files.list(cases).use { files ->
            files.filter { it.name.endsWith(".json") }.sorted().toList()
                .map { it.name.removeSuffix(".json") to MAPPER.readTree(it.readText()) }
                .filter { it.second.get("dialect").asText() in setOf(CORE, KOTLIN) }
        }

    @Test
    fun the_corpus_has_core_and_kotlin_cases() {
        val dialects = corpus().map { it.second.get("dialect").asText() }.toSet()
        assertEquals(setOf(CORE, KOTLIN), dialects)
    }

    @TestFactory
    fun cases(): List<DynamicTest> = corpus().map { (name, c) -> DynamicTest.dynamicTest(name) { check(c) } }

    private fun check(c: JsonNode) {
        val core = c.get("dialect").asText() == CORE
        if (core) assertNotNull(c.get("options"), "a core case states its options")
        if (c.has("error")) {
            try {
                run(c, core)
            } catch (e: WriterException) {
                assertEquals(c.get("error").asText(), e.code())
                if (c.has("errorQuotes")) assertTrue(e.message!!.contains(c.get("errorQuotes").asText()), e.message)
                return
            }
            fail("expected " + c.get("error").asText())
        }
        val lines = c.get("expected").map { it.asText() }
        assertEquals(if (lines.isEmpty()) "" else lines.joinToString("\n") + "\n", run(c, core))
    }

    private fun run(c: JsonNode, core: Boolean): String {
        val w: CodeWriter = if (core) CodeWriter(options(c, core)) else KotlinWriter(options(c, core))
        for (op in c.get("ops")) {
            val name = op.get(0).asText()
            val args = (1 until op.size()).map { piece(op.get(it)) }
            when (name) {
                "line" -> w.line(*args.toTypedArray())
                "open" -> w.open(*args.toTypedArray())
                "close" -> w.close(*args.toTypedArray())
                "blank" -> w.blank()
                "text" -> w.text(args[0] as String)
                else -> {
                    val k = w as? KotlinWriter ?: error("op $name is not a core op")
                    val s = args.map { it as String }
                    when (name) {
                        "package" -> k.packageName(s[0])
                        "use" -> k.use(s[0])
                        "useAs" -> k.use(s[0], s[1])
                        "header" -> k.header(*s.toTypedArray())
                        "doc" -> k.doc(*s.toTypedArray())
                        "reopen" -> k.reopen(*args.toTypedArray())
                        else -> error("unknown op $name")
                    }
                }
            }
        }
        return w.toString()
    }

    /** The case's options laid over the dialect's defaults (core states all three). */
    private fun options(c: JsonNode, core: Boolean): WriterOptions {
        var o = if (core) WriterOptions("  ", 120, true) else KotlinWriter.KOTLIN
        val given = c.get("options") ?: return o
        given.get("indent")?.let { o = o.withIndent(it.asText()) }
        given.get("width")?.let { o = o.withWidth(it.asInt()) }
        given.get("trailingComma")?.let { o = o.withTrailingComma(it.asBoolean()) }
        return o
    }

    private fun piece(p: JsonNode): Any = when {
        p.isTextual -> p.asText()
        p.isArray -> p.map { piece(it) }
        else -> {
            val l = p.get("list")
            Group(l.get("open").asText(), l.get("items").map { piece(it) }, l.get("close").asText(), l.path("pad").asBoolean(false))
        }
    }

    private companion object {
        const val CORE = "core"
        const val KOTLIN = "kotlin"
        val MAPPER = ObjectMapper()
    }
}
