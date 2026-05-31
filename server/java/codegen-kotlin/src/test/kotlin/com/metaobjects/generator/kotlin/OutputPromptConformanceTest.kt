package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.render.prompt.OutputFormatRenderer
import com.metaobjects.render.prompt.OutputFormatSpec
import com.metaobjects.render.prompt.PromptField
import com.metaobjects.render.prompt.PromptOverrides
import com.metaobjects.render.prompt.PromptStyle
import com.metaobjects.render.recover.FieldKind
import com.metaobjects.render.recover.FieldRecovery
import com.metaobjects.render.recover.FieldSpec
import com.metaobjects.render.recover.Format
import com.metaobjects.render.recover.Recover
import com.metaobjects.render.recover.RecoverOptions
import com.metaobjects.render.recover.RecoverSchema
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port byte-identity gate for the FR-010 output-format prompt fragment — Kotlin runner.
 *
 * Kotlin REUSES the shared JVM `render` engine (the same Java [OutputFormatRenderer] and
 * [Recover] classes that the Java runner validates). This runner drives those Java classes
 * directly against the shared corpus at `fixtures/output-prompt-conformance/`, proving the
 * corpus loads + runs in the Kotlin module. Byte-identity to Java/TS/C#/Python holds by
 * construction (same engine); the value here is the loads-in-Kotlin guarantee.
 *
 * Transliterated from `render`'s OutputPromptConformanceTest.java. Assertions are ordinal
 * String equality on raw UTF-8 bytes with no newline translation — the corpus is the oracle.
 */
class OutputPromptConformanceTest {

    private val json = ObjectMapper()

    /** Count guard: a port silently skipping cases must fail. Bump when adding cases. */
    private val expectedCaseCount = 12

    private data class StyleSpec(val key: String, val style: PromptStyle)

    private val styles = listOf(
        StyleSpec("guide", PromptStyle.GUIDE),
        StyleSpec("inline", PromptStyle.INLINE),
        StyleSpec("exampleOnly", PromptStyle.EXAMPLE_ONLY),
    )

    private fun corpus(): Path {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/output-prompt-conformance"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate fixtures/output-prompt-conformance from user.dir")
        return p!!.resolve("fixtures/output-prompt-conformance")
    }

    private fun cases(): List<Path> {
        val root = corpus()
        assertTrue(Files.isDirectory(root), "corpus missing at $root")
        return Files.list(root).use { stream ->
            stream.filter { Files.isDirectory(it) }
                .filter { Files.exists(it.resolve("spec.json")) }
                .sorted()
                .toList()
        }
    }

    @Test
    fun `reproduces corpus bytes for every case`() {
        val dirs = cases()
        assertEquals(expectedCaseCount, dirs.size, "output-prompt-conformance case count")

        for (dir in dirs) {
            val spec = json.readTree(dir.resolve("spec.json").toFile())
            val ofs = buildOutputSpec(spec)

            for (s in styles) {
                val overrides = PromptOverrides(s.style, emptyMap<String, String>(), emptyMap<String, String>())
                val actual = OutputFormatRenderer.render(ofs, overrides)
                val expected = readUtf8(dir.resolve("expected.${s.key}.txt"))
                assertEquals(expected, actual, "$dir style[${s.key}]")
                // determinism: identical across runs
                assertEquals(
                    actual,
                    OutputFormatRenderer.render(ofs, overrides),
                    "$dir style[${s.key}] (determinism)",
                )
            }

            if (spec.has("roundTrip") && spec.get("roundTrip").asBoolean()) {
                val exampleFragment = readUtf8(dir.resolve("expected.exampleOnly.txt"))
                val outcome = Recover.recover(exampleFragment, buildRecoverSchema(spec), RecoverOptions.defaults())
                // Skew guard: a field the renderer emitted must read back cleanly. Assert NO state
                // is MALFORMED or LOST_* (robust to DEFAULTED and to how a nested OBJECT-container
                // path classifies); any such state means the renderer emitted an example the
                // recover parser cannot read.
                for ((field, state) in outcome.report().states()) {
                    val bad = state == FieldRecovery.MALFORMED ||
                        state == FieldRecovery.LOST_REQUIRED ||
                        state == FieldRecovery.LOST_OPTIONAL
                    assertFalse(bad, "$dir roundTrip state[$field]=$state")
                }
            }
        }
    }

    private fun readUtf8(p: Path): String = String(Files.readAllBytes(p), StandardCharsets.UTF_8)

    // ----- descriptor (spec.json) -> renderer/recover model -----

    private fun buildOutputSpec(c: JsonNode): OutputFormatSpec {
        val fmt = toFormat(c.get("format").asText())
        val root = c.get("rootName").asText()
        val fields = c.get("fields").map { buildPromptField(it) }
        // style is a placeholder; each render overrides it per style.
        return OutputFormatSpec(fmt, root, PromptStyle.GUIDE, fields)
    }

    private fun buildPromptField(f: JsonNode): PromptField {
        val name = f.get("name").asText()
        val kind = FieldKind.valueOf(f.get("kind").asText())
        val required = f.has("required") && f.get("required").asBoolean()
        val array = f.has("array") && f.get("array").asBoolean()
        val enumValues: List<String>? =
            if (f.has("enumValues") && !f.get("enumValues").isNull) f.get("enumValues").map { it.asText() } else null
        val enumDoc: Map<String, String>? =
            if (f.has("enumDoc") && !f.get("enumDoc").isNull) {
                val m = LinkedHashMap<String, String>()
                f.get("enumDoc").fields().forEachRemaining { m[it.key] = it.value.asText() }
                m
            } else {
                null
            }
        val example = if (f.has("example") && !f.get("example").isNull) f.get("example").asText() else null
        val instruction = if (f.has("instruction") && !f.get("instruction").isNull) f.get("instruction").asText() else null
        val nested = if (f.has("nested") && !f.get("nested").isNull) buildOutputSpec(f.get("nested")) else null
        return PromptField(name, kind, required, array, enumValues, enumDoc, example, instruction, nested)
    }

    private fun buildRecoverSchema(c: JsonNode): RecoverSchema {
        val fmt = toFormat(c.get("format").asText())
        val root = c.get("rootName").asText()
        val fields = c.get("fields").map { buildFieldSpec(it) }
        return RecoverSchema(fmt, root, fields)
    }

    private fun buildFieldSpec(f: JsonNode): FieldSpec {
        val name = f.get("name").asText()
        val kind = FieldKind.valueOf(f.get("kind").asText())
        val required = f.has("required") && f.get("required").asBoolean()
        val array = f.has("array") && f.get("array").asBoolean()
        if (kind == FieldKind.ENUM) {
            val vals: List<String>? =
                if (f.has("enumValues") && !f.get("enumValues").isNull) f.get("enumValues").map { it.asText() } else null
            return FieldSpec.enumField(name, required, vals, emptyMap<String, String>())
        }
        if (kind == FieldKind.OBJECT) {
            val nested = if (f.has("nested") && !f.get("nested").isNull) buildRecoverSchema(f.get("nested")) else null
            return FieldSpec.`object`(name, required, array, nested)
        }
        return FieldSpec.scalar(name, kind, required)
    }

    private fun toFormat(f: String): Format = if ("json" == f) Format.JSON else Format.XML
}
