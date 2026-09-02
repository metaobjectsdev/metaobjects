package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Task 6 — [KotlinExposedTableGenerator]'s Exposed table binding references
 * `<Entity>Names.NAME` / `<Entity>Names.<FIELD>_COLUMN` instead of respelling the
 * physical table/column names as string literals, behind the `useNames` generator arg
 * (default OFF — see [KotlinGenUtil.ARG_USE_NAMES]). Kotlin generators are selected by
 * FQCN in the pom with no runner aggregating markers, so a project running the table
 * generator WITHOUT [KotlinNamesGenerator] in the same run would reference a type
 * nothing generated and fail to compile — hence the opt-in, defaulting OFF.
 *
 * See [KotlinExposedTableSourceSelectionTest] for R27 — the prerequisite fix to WHICH
 * source the table generator names, independent of this substitution.
 */
class KotlinExposedTableNamesTest {

    // callPurpose deliberately carries an explicit @column that is NOT the snake_case
    // of its own name -- the discriminator between "reads the resolved column" and
    // "re-derives it", same rationale as KotlinNamesGeneratorTest's identical fixture.
    private val authorModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "callPurpose", "@maxLength": 40, "@column": "purpose_code" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Runs KotlinNamesGenerator (unconditional) + KotlinExposedTableGenerator (given
     *  args) over [authorModel] into a shared outDir, returning the emitted
     *  AuthorTable.kt text. */
    private fun authorTableSrc(tableArgs: Map<String, String> = emptyMap()): String {
        val outDir = Files.createTempDirectory("ktbl-names-")
        try {
            val loader = loadString("test", authorModel)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator()
                .apply { setArgs(tableArgs + mapOf("outputDir" to outDir.toString())) }
                .execute(loader)
            return outDir.resolve("acme/demo/AuthorTable.kt").readText()
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `the table binding references the name constants when names is enabled`() {
        val src = authorTableSrc(mapOf("useNames" to "true"))
        assertTrue("object AuthorTable : Table(AuthorNames.NAME)" in src, src)
        assertTrue("varchar(AuthorNames.CALL_PURPOSE_COLUMN, 40)" in src, src)
        // The literal the strategy WOULD have produced, and the table literal itself,
        // must be GONE -- a positive assertion alone would still pass a generator that
        // emitted BOTH the constant reference and the old literal.
        assertFalse("Table(\"authors\")" in src, src)
        assertFalse("\"purpose_code\"" in src, src)
    }

    @Test fun `the table binding keeps its literals by default`() {
        // Kotlin generators are pom-selected. A project that runs the table generator
        // without the names generator must still compile, so OFF is the default and
        // the output stays byte-identical.
        val src = authorTableSrc()
        assertTrue("Table(\"authors\")" in src, src)
        assertTrue("varchar(\"purpose_code\", 40)" in src, src)
        assertFalse("AuthorNames" in src, src)
    }
}
