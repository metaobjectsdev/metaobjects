package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.GeneratorBase
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.metadata.ktx.loadDirectory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Selection in the Kotlin port: a generator's `<filters>` and the run's entity selection
 * (`-Dmeta.entities`) both narrow the objects it writes files for, over the shared canonical
 * model.
 *
 * Until 1.3.0 every Kotlin generator iterated the whole model and ignored `<filters>`. The
 * selection names an entity (`Person`), a value object (`Settings`) and a served report
 * (`ProgramMinutes`), so each generator has something to emit.
 */
class KotlinSelectionTest {

    private val selected = listOf("Person", "Settings", "ProgramMinutes")
    private val filters = selected.map { "fitness::$it" }

    /** Objects outside the selection: no file may be named after one in a narrowed run. */
    private val unselected = listOf("Week", "Tag", "AllTypes", "Gadget", "Post", "Asset", "Session")

    private fun generators(): List<Pair<String, Generator>> = listOf(
        "entity" to KotlinEntityGenerator(),
        "table" to KotlinExposedTableGenerator(),
        "names" to KotlinNamesGenerator(),
        "relations" to KotlinRelationsGenerator(),
        "filter-allowlist" to KotlinFilterAllowlistGenerator(),
        "validator" to KotlinValidatorGenerator(),
        "repository" to KotlinRepositoryGenerator(),
        "controller" to KotlinSpringControllerGenerator(),
        "stored-proc" to KotlinStoredProcGenerator(),
        "report-export" to KotlinReportExportGenerator(),
    )

    private fun findCorpusRoot(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/persistence-conformance")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate fixtures/persistence-conformance")
    }

    /** Run every generator over the canonical model; return each file's relative path and content. */
    private fun generate(narrow: (Generator) -> Unit): Map<String, String> {
        val canonical = findCorpusRoot().resolve("canonical")
        val outDir = Files.createTempDirectory("kotlin-selection-")
        try {
            // One loader name for every run: some output embeds it.
            val loader = loadDirectory("fitness", canonical)
            GeneratedFileWriter.beginRun().use { run ->
                for ((key, gen) in generators()) {
                    run.attributeTo(gen.javaClass.simpleName)
                    gen.setArgs(mapOf(
                        // Its own directory each: this compares outputs, not a project.
                        "outputDir" to outDir.resolve(key).toString(),
                        "packageName" to "fitness",
                    ))
                    narrow(gen)
                    gen.execute(loader)
                }
            }
            return Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.toList()
                    .associate { outDir.relativize(it).toString() to it.readText() }
                    .toSortedMap()
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * [wholeModelUnchanged] is true for the entity selection, which must leave every
     * whole-model file exactly as a full run writes it, and false for `<filters>`, which
     * narrow what a whole-model file covers as well.
     */
    private fun assertNarrowed(how: String, full: Map<String, String>, narrowed: Map<String, String>,
                               wholeModelUnchanged: Boolean) {
        assertFalse(narrowed.isEmpty(), "$how: wrote nothing")
        assertTrue(narrowed.size < full.size, "$how: wrote ${narrowed.size} of ${full.size} files; expected fewer")
        for ((path, content) in narrowed) {
            assertTrue(full.containsKey(path), "$how: wrote $path, which a full run does not")
            val file = Path.of(path).fileName.toString()
            if (wholeModelUnchanged || selected.any { file.startsWith(it) }) {
                assertEquals(full[path], content, "$how: $path differs from a full run")
            }
            for (other in unselected) {
                assertFalse(file.startsWith(other), "$how: wrote $path for an object outside the selection")
            }
        }
        for (name in selected) {
            assertTrue(narrowed.keys.any { Path.of(it).fileName.toString().startsWith(name) },
                "$how: wrote no file for $name")
        }
        assertTrue(narrowed.keys.any { it.endsWith("PersonController.kt") }, "$how: a per-object controller is missing")
    }

    @Test
    fun filtersNarrowEveryGenerator() {
        val full = generate { }
        val filtered = generate { it.setFilters(filters) }
        assertNarrowed("<filters>", full, filtered, wholeModelUnchanged = false)
    }

    @Test
    fun theEntitySelectionNarrowsPerObjectOutput() {
        val full = generate { }
        val narrowed = generate { (it as GeneratorBase).setEntities(selected) }
        assertNarrowed("entities", full, narrowed, wholeModelUnchanged = true)
    }

    @Test
    fun anEmptySelectionSelectsEverything() {
        val full = generate { }
        assertEquals(full, generate { (it as GeneratorBase).setEntities(emptyList()) })
    }
}
