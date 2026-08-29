package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The Exposed table's column STRING is the physical column name, so it must honour
 * `@column` and the project's column-naming strategy.
 *
 * It used to do neither: every column was hardcoded `camelToSnake(field.name)`, so an
 * explicit `@column` was silently discarded and the generated table bound the wrong
 * column at runtime, with no error anywhere. Kotlin was also the only port hardcoding
 * snake_case — Java's OMDB `getColumnRef`, Python's `_column_of` and C#'s default all
 * resolve literal — so one metadata model produced two different column names across
 * the two JVM ports.
 *
 * The Kotlin PROPERTY name stays `field.name`-derived in every case: that is the
 * language-level identifier, a different axis from the physical column.
 */
class KotlinExposedTableColumnNamingTest {

    /** `@column` deliberately is NOT the snake_case of the field name — that coincidence
     *  is what made the old behaviour look correct. */
    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "LlmCall", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "callPurpose", "@maxLength": 40, "@column": "purpose_code" } },
            { "field.string": { "name": "modelName", "@maxLength": 40 } },
            { "source.rdb":   { "@table": "llm_calls" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun generate(args: Map<String, String>): String {
        val outDir = Files.createTempDirectory("ktbl-colnaming-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(args + mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))
            return Files.readString(outDir.resolve("acme/demo/LlmCallTable.kt"))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `an explicit column attribute is the column name`() {
        val src = generate(emptyMap())
        assertTrue("""val callPurpose = varchar("purpose_code", 40)""" in src, src)
        // The property keeps the field name; only the column string moves.
        assertTrue("call_purpose" !in src, src)
    }

    @Test fun `a field with no column attribute follows the default strategy`() {
        val src = generate(emptyMap())
        assertTrue("""val modelName = varchar("model_name", 40)""" in src, src)
    }

    @Test fun `columnNaming literal leaves an unannotated field name alone`() {
        val src = generate(mapOf("columnNaming" to "literal"))
        assertTrue("""val modelName = varchar("modelName", 40)""" in src, src)
        // An explicit @column always wins, whatever the strategy.
        assertTrue("""val callPurpose = varchar("purpose_code", 40)""" in src, src)
    }
}
