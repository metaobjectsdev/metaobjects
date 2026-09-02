package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * R27 — [KotlinExposedTableGenerator]'s single-object emission path must select its
 * `source.rdb` through the SAME role-scoped resolver [KotlinGenUtil.resolveObjectNames]
 * uses ([KotlinGenUtil.primaryRdbSource]), never [KotlinGenUtil.firstRdbSource] (which
 * is role-BLIND — it returns whichever `source.rdb` was declared FIRST).
 *
 * This predates and is independent of Task 6's `useNames` opt-in substitution: it is a
 * correctness fix to what the table generator's EXISTING literal names, verified here by
 * comparing that literal against [KotlinNamesGenerator]'s (already-shipped, role-scoped)
 * `<Entity>Names.NAME` constant for the same model. An object can declare two OWN
 * sources of the SAME writable-or-read-only-ness — two read-only views/materializedViews,
 * or two writable tables (`ValidateOnePrimarySource` only forbids two OWN sources both
 * claiming `@role: primary`, never two of the same writability with only one marked
 * primary) — in either declaration order, and still load with zero errors.
 * [KotlinGenUtil.firstRdbSource] picks whichever was declared FIRST; the correct pick is
 * whichever resolves `role == primary`. Before this fix the two literally disagreed on
 * real, loadable metadata.
 */
class KotlinExposedTableSourceSelectionTest {

    /** Runs KotlinNamesGenerator + KotlinExposedTableGenerator (both default args) over
     *  [model] into a shared outDir, returning every emitted file's text keyed by its
     *  path relative to outDir. */
    private fun emit(model: String): Map<String, String> {
        val outDir = Files.createTempDirectory("ktbl-srcsel-")
        try {
            val loader = loadString("test", model)
            KotlinNamesGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)

            return Files.walk(outDir).use { stream ->
                stream.filter { Files.isRegularFile(it) }
                    .toList()
                    .associate { outDir.relativize(it).toString() to it.readText() }
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // A projection with TWO read-only sources, @role: replica declared BEFORE
    // @role: primary. isWriteThrough() is false (no writable source at all), so this
    // takes the single-object emission path.
    private val twoReadOnlyModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.projection": { "name": "TwoRoView", "children": [
            { "source.rdb": { "@kind": "view", "@view": "two_ro_replica", "@role": "replica" } },
            { "source.rdb": { "@kind": "view", "@view": "two_ro_primary", "@role": "primary" } },
            { "field.int": { "name": "id" } }
        ] } }
      ] }
    }""".trimIndent()

    // An entity with TWO writable sources, @role: replica declared BEFORE
    // @role: primary (a non-primary writable role is unrestricted). isWriteThrough()
    // is false (no read-only source at all), so this too takes the single-object path.
    private val twoWritableModel = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "TwoRwEntity", "children": [
            { "source.rdb": { "@table": "two_rw_replica", "@role": "replica" } },
            { "source.rdb": { "@table": "two_rw_primary", "@role": "primary" } },
            { "field.int": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `the table binding names the role=primary source, not the first-declared one -- two read-only sources`() {
        assertNamesPrimarySource(twoReadOnlyModel, "TwoRoView", "two_ro_primary", "two_ro_replica")
    }

    @Test fun `the table binding names the role=primary source, not the first-declared one -- two writable sources`() {
        assertNamesPrimarySource(twoWritableModel, "TwoRwEntity", "two_rw_primary", "two_rw_replica")
    }

    /**
     * The table generator's literal `Table("...")` and [KotlinNamesGenerator]'s
     * (independently-resolved) `<Entity>Names.NAME` constant must name the SAME
     * physical string -- [expectedPrimary], the role=primary source -- and NEVER
     * [wrongIfFirstDeclared], the string a role-BLIND, first-declared selector would
     * have produced. Comparing the table generator's output against a SEPARATE
     * generator's SEPARATE resolution of the same model is the point: two consumers
     * computing the same fact must land on one answer.
     */
    private fun assertNamesPrimarySource(
        model: String, shortName: String, expectedPrimary: String, wrongIfFirstDeclared: String,
    ) {
        val files = emit(model)
        val tableSrc = files.getValue("acme/demo/${shortName}Table.kt")
        val namesSrc = files.getValue("acme/demo/${shortName}Names.kt")

        // Sanity: KotlinNamesGenerator (unrelated to this fix, unchanged by it) really
        // does resolve the primary source, confirming the fixture is well-formed.
        assertTrue("const val NAME: String = \"$expectedPrimary\"" in namesSrc, namesSrc)
        assertFalse("const val NAME: String = \"$wrongIfFirstDeclared\"" in namesSrc, namesSrc)

        // The fix under test: the table generator's own literal must agree.
        assertTrue("Table(\"$expectedPrimary\")" in tableSrc, tableSrc)
        assertFalse("Table(\"$wrongIfFirstDeclared\")" in tableSrc, tableSrc)
    }
}
