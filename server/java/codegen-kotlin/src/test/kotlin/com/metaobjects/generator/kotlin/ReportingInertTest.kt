package com.metaobjects.generator.kotlin

import com.metaobjects.generator.kotlin.apidocs.DocsPaths
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.metadata.ktx.loadDirectory
import com.metaobjects.`object`.MetaObject
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-044 Plan 1 — the reporting vocabulary is INERT in every Kotlin generator.
 *
 * Plan 1 registers `dimension.*`, `measure.*`, `segment.*` and `object.report` and validates
 * them at load, but gives none of them output: a report's lowering lands in Plan 2/3. Until
 * then a model that USES the vocabulary must generate exactly what the same model without it
 * generates, byte for byte, through every generator in [GENERATOR_REGISTRY].
 *
 * The model pair is `fixtures/codegen-noop/reporting/{with,without}`, shared with the other
 * four ports' copies of this test. `with/` carries a report that declares a read-only
 * `source.rdb @kind: view` (R5 allows one) — the shape that leaked in C#.
 */
class ReportingInertTest {

    private fun modelDir(variant: String): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/codegen-noop/reporting/$variant")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate fixtures/codegen-noop/reporting from ${Paths.get("").toAbsolutePath()}")
    }

    // One loader name for both variants, so nothing that stamps it into output can differ.
    private fun load(variant: String) = loadDirectory("reporting-inert", modelDir(variant))

    /**
     * Run a generator suite into a fresh directory and read back every file it wrote:
     * relative path to contents. A throw is recorded as the single entry `<threw>`, so a
     * generator that cannot run from a bare model must at least fail identically.
     */
    private fun emit(variant: String, suite: List<GeneratorInfo>): Map<String, String> {
        val loader = load(variant)
        val outDir = Files.createTempDirectory("reporting-inert-")
        val templateRoot = Files.createTempDirectory("reporting-inert-templates-")
        try {
            try {
                GeneratedFileWriter.beginRun().use { run ->
                    for (info in suite) {
                        val gen = info.factory()
                        run.attributeTo(info.name)
                        gen.setArgs(mapOf(
                            "outputDir" to outDir.toString(),
                            // KotlinValidatorGenerator emits a package-level stub and needs one.
                            "packageName" to "acme.shop",
                            "templateRoot" to templateRoot.toString(),
                        ))
                        gen.execute(loader)
                    }
                }
            } catch (e: Exception) {
                return mapOf(THREW to e.message.toString())
            }
            val files = TreeMap<String, String>()
            Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.forEach { files[outDir.relativize(it).toString()] = it.readText() }
            }
            return files
        } finally {
            outDir.toFile().deleteRecursively()
            templateRoot.toFile().deleteRecursively()
        }
    }

    private fun sameOrLeak(label: String, expected: Map<String, String>, actual: Map<String, String>): String? {
        if (expected.keys.toList() != actual.keys.toList()) {
            return "$label: emitted file set ${expected.keys} became ${actual.keys}"
        }
        val differing = expected.keys.filter { expected[it] != actual[it] }
        return if (differing.isEmpty()) null else "$label: $differing differ once reporting nodes are declared"
    }

    @Test
    fun `the with-model really carries the vocabulary`() {
        // Else every comparison below is vacuously green.
        val reports = load("with").metaObjects
            .filter { it.subType == MetaObject.SUBTYPE_REPORT }
            .map { it.shortName }
            .sorted()
        assertEquals(listOf("DailyRevenue", "ProgramEngagement", "StoreTotals"), reports)
        assertFalse(load("without").metaObjects.any { it.subType == MetaObject.SUBTYPE_REPORT })
    }

    @Test
    fun `every generator emits the same files with and without reporting nodes`() {
        // Every generator is compared before anything is asserted, so one red run names
        // every leak rather than the first.
        val leaks = GENERATOR_REGISTRY.values.mapNotNull { info ->
            sameOrLeak(info.name, emit("without", listOf(info)), emit("with", listOf(info)))
        }
        assertTrue(leaks.isEmpty(), leaks.joinToString("\n"))
    }

    @Test
    fun `every runnable generator in one run emits the same files`() {
        val runnable = GENERATOR_REGISTRY.values.filter { THREW !in emit("without", listOf(it)) }
        val expected = emit("without", runnable)
        assertFalse(THREW in expected, "the combined suite threw: ${expected[THREW]}")
        assertTrue(expected.size > 10, "only ${expected.size} files — the suite barely ran")
        val leak = sameOrLeak("combined", expected, emit("with", runnable))
        assertTrue(leak == null, leak)
    }

    /**
     * The api docs surface: every unit page, the index and the agent page. A report has no
     * generated API to document, and its derived fields do not exist until its lowering lands.
     */
    private fun apiDocs(variant: String): Map<String, String> {
        val model = KotlinApiModelBuilder().build(load(variant), "shop")
        val renderer = KotlinApiDocsRenderer()
        val pages = TreeMap<String, String>()
        for (unit in model.units) {
            pages[DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, unit.pkg, unit.node)] =
                renderer.renderUnitPage(unit, null)
        }
        pages["README.md"] = renderer.renderIndex(model, DocsPaths.Layout.PACKAGE)
        pages["AGENT-API.md"] = renderer.renderAgentApi(model)
        return pages
    }

    @Test
    fun `api docs are the same with and without reporting nodes`() {
        val expected = apiDocs("without")
        assertTrue(expected.size > 3, "only ${expected.size} pages — the docs barely ran")
        val leak = sameOrLeak("api docs", expected, apiDocs("with"))
        assertTrue(leak == null, leak)
    }

    private companion object {
        const val THREW = "<threw>"
    }
}
