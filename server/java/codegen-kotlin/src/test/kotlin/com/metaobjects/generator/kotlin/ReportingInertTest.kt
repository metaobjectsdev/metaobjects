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
 * FR-044 — what the reporting vocabulary generates in Kotlin, and what stays INERT.
 *
 * `dimension.*`, `measure.*` and `segment.*` generate nothing anywhere. An `object.report`
 * with no read-only source generates nothing anywhere. A report that declares a read-only
 * `source.rdb @kind: view` is lowered to that view (by TypeScript migrate), and Kotlin
 * generates exactly one thing for it: its read-only Exposed table, from
 * [KotlinExposedTableGenerator]. Every other generator in [GENERATOR_REGISTRY] — entity,
 * names, relations, repository, controller, filter allowlist, the docs tier — emits for a
 * model that USES the vocabulary exactly what it emits for the same model without it, byte
 * for byte.
 *
 * The model pair is `fixtures/codegen-noop/reporting/{with,without}`, shared with the other
 * four ports' copies of this test. `with/` carries two sourceless reports
 * (`ProgramEngagement`, `DailyRevenue`) and one view-backed one (`StoreTotals`).
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

    /**
     * Null when [actual] is [expected] plus exactly the files in [added] (path to contents,
     * empty for a generator that must stay inert); else what leaked.
     */
    private fun sameOrLeak(
        label: String,
        expected: Map<String, String>,
        actual: Map<String, String>,
        added: Map<String, String> = emptyMap(),
    ): String? {
        val wanted = TreeMap(expected).apply { putAll(added) }
        if (wanted.keys.toList() != actual.keys.toList()) {
            return "$label: emitted file set ${wanted.keys} became ${actual.keys}"
        }
        val differing = wanted.keys.filter { wanted[it] != actual[it] }
        return if (differing.isEmpty()) null else "$label: $differing differ once reporting nodes are declared"
    }

    /** What a generator may add for the with-model: the view-backed report's table, and only from `exposed-table`. */
    private fun allowedFor(info: GeneratorInfo): Map<String, String> =
        if (info.name == EXPOSED_TABLE) mapOf(STORE_TOTALS_TABLE_PATH to STORE_TOTALS_TABLE) else emptyMap()

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
    fun `only the Exposed table generator emits for a report, and only the view-backed one's table`() {
        // Every generator is compared before anything is asserted, so one red run names
        // every leak rather than the first.
        val leaks = GENERATOR_REGISTRY.values.mapNotNull { info ->
            sameOrLeak(info.name, emit("without", listOf(info)), emit("with", listOf(info)), allowedFor(info))
        }
        assertTrue(leaks.isEmpty(), leaks.joinToString("\n"))
    }

    @Test
    fun `the view-backed report emits exactly its Exposed table`() {
        // Else the allowance above is vacuous: the table really is emitted, with this content.
        val info = GENERATOR_REGISTRY.getValue(EXPOSED_TABLE)
        val added = emit("with", listOf(info)) - emit("without", listOf(info)).keys
        assertEquals(mapOf(STORE_TOTALS_TABLE_PATH to STORE_TOTALS_TABLE), added)
    }

    @Test
    fun `a sourceless report appears in no generated file`() {
        val files = emit("with", GENERATOR_REGISTRY.values.toList())
        assertFalse(THREW in files, "the combined suite threw: ${files[THREW]}")
        for (report in listOf("ProgramEngagement", "DailyRevenue")) {
            val hits = files.filter { (path, text) -> report in path || report in text }.keys
            assertTrue(hits.isEmpty(), "$report leaked into $hits")
        }
        // The view-backed report is named by its table and by nothing else.
        val hits = files.filter { (path, text) -> "StoreTotals" in path || "StoreTotals" in text }.keys
        assertEquals(setOf(STORE_TOTALS_TABLE_PATH), hits)
    }

    @Test
    fun `exactly these generators cannot run from a bare model`() {
        // Each is compared above on its error message alone, which proves nothing about its
        // output. Pinned by name so a generator that starts throwing cannot drop out
        // silently; the list may only shrink.
        val threw = GENERATOR_REGISTRY.values.filter { THREW in emit("without", listOf(it)) }.map { it.name }.sorted()
        assertEquals(emptyList(), threw)
    }

    @Test
    fun `every runnable generator in one run emits the same files`() {
        val runnable = GENERATOR_REGISTRY.values.filter { THREW !in emit("without", listOf(it)) }
        val expected = emit("without", runnable)
        assertFalse(THREW in expected, "the combined suite threw: ${expected[THREW]}")
        assertTrue(expected.size > 10, "only ${expected.size} files — the suite barely ran")
        val leak = sameOrLeak(
            "combined", expected, emit("with", runnable), mapOf(STORE_TOTALS_TABLE_PATH to STORE_TOTALS_TABLE))
        assertTrue(leak == null, leak)
    }

    /**
     * The api docs surface: every unit page, the index and the agent page. A report has no
     * generated API to document — no route, repository or DTO — whether or not it has a view.
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

        /** The registry id of [KotlinExposedTableGenerator]. */
        const val EXPOSED_TABLE = "exposed-table"

        const val STORE_TOTALS_TABLE_PATH = "acme/shop/StoreTotalsTable.kt"

        /** `StoreTotals`: three measures over `Purchase` — two counts and a sum of a currency. */
        val STORE_TOTALS_TABLE = """
            |package acme.shop
            |
            |import org.jetbrains.exposed.sql.Table
            |
            |/** READ-ONLY VIEW — generated from view metadata; do not insert/update/delete directly. */
            |/** GENERATED — do not hand-edit. Regenerated from metadata. */
            |object StoreTotalsTable : Table("v_store_totals") {
            |    val purchases = long("purchases")
            |    val buyers = long("buyers")
            |    val revenue = long("revenue").nullable()
            |}
            |""".trimMargin()
    }
}
