package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import org.junit.jupiter.api.Test
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A string `@default` is the data class's ctor default unless it is a database expression, by the
 * rule `meta migrate` and every port share (`now`, `current_timestamp`, `current_date`,
 * `current_time`, or a call ending in `()`). Parentheses alone do not make an expression, and a
 * newline or quote in the default is escaped into the Kotlin literal.
 */
class KotlinStringDefaultLiteralTest {

    private val model = """
        { "metadata.root": { "package": "acme::setting", "children": [
          { "object.entity": { "name": "Setting", "children": [
            { "source.rdb": { "@table": "settings" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "label", "@default": "N/A (unknown)" } },
            { "field.string": { "name": "note", "@default": "line one\nline \"two\" ${'$'}x" } },
            { "field.string": { "name": "token", "@default": "gen_random_uuid()" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
    """.trimIndent()

    @Test
    fun `a string default is a literal unless it is a database expression`() {
        val out = Files.createTempDirectory("kgen-str-default-")
        try {
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }
                .execute(loadString("stringDefaults", model))
            val src = out.resolve("acme/setting/Setting.kt").readText()
            assertTrue("\"N/A (unknown)\"" in src, "label keeps its literal default; saw:\n$src")
            assertTrue("\"line one\\nline \\\"two\\\" \\\$x\"" in src, "note's default is escaped; saw:\n$src")
            assertFalse("gen_random_uuid" in src, "a database expression is not a ctor default; saw:\n$src")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
