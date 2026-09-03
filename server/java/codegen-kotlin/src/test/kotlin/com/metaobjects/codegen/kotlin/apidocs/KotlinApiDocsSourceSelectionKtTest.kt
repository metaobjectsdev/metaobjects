package com.metaobjects.codegen.kotlin.apidocs

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinStoredProcGenerator
import com.metaobjects.generator.kotlin.apidocs.ApiSymbolKind
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.source.RdbSource
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The api-docs builder must select a projection's `source.rdb` the SAME way the generators
 * it documents do — by `@role: primary`, never by declaration order.
 *
 * The two generators that own a projection's data-access symbol
 * ([KotlinExposedTableGenerator] and [KotlinStoredProcGenerator]) both select with
 * `KotlinGenUtil.primaryRdbSource`. The api-docs builder's `projectionDataAccess` selected
 * with the role-blind `firstRdbSource`, so on an object whose first-DECLARED source is not
 * its primary the two disagree — and because the builder dispatches Table-doc vs Proc-doc on
 * that source's `@kind`, the disagreement is not a wrong table NAME but a wrong SYMBOL: the
 * docs name `<Short>Table`, and the only thing any generator emits is `<Short>Proc`.
 *
 * REACHABILITY — the mechanism, not an assertion of one. The two sources carry DISTINCT
 * explicit `name` values. Two same-named children of the same type collide and shadow, so a
 * fixture using unnamed sources proves nothing about a shape where both survive;
 * [twoDistinctlyNamedSourcesBothSurviveOnChildren] pins that they do before any other
 * assertion here means anything.
 */
class KotlinApiDocsSourceSelectionKtTest {

    private companion object {
        const val PROJECT = "apidocs-source-selection"
    }

    // PhaseSummary declares its @role:replica VIEW source FIRST and its @role:primary
    // STORED-PROC source SECOND. Both are read-only kinds, so nothing about the shape is
    // exotic beyond the declaration order, and it loads with zero errors.
    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.projection": { "name": "PhaseSummary", "children": [
            { "source.rdb": { "name": "replicaView", "@kind": "view",
                              "@table": "v_phase_summary", "@role": "replica" } },
            { "source.rdb": { "name": "primaryProc", "@kind": "storedProc",
                              "@proc": "fn_phase_summary", "@role": "primary" } },
            { "field.int":    { "name": "id" } },
            { "field.string": { "name": "label" } }
        ] } }
      ] }
    }""".trimIndent()

    private lateinit var loader: MetaDataLoader
    private lateinit var outDir: Path
    private lateinit var allGenerated: String

    @BeforeTest
    fun setUp() {
        loader = loadString("apidocs-source-selection", fixture)
        // Asserted, not assumed: `loadString` collects child-level errors rather than
        // throwing, so a fixture that stopped loading would pass every assertion below.
        assertEquals(emptyList(), loader.getErrors().map { it.message }, "fixture must load cleanly")
        outDir = Files.createTempDirectory("kapidocs-src-")
        val dir = outDir.toString()
        run(KotlinEntityGenerator(), mapOf("outputDir" to dir))
        run(KotlinExposedTableGenerator(), mapOf("outputDir" to dir))
        run(KotlinStoredProcGenerator(), mapOf("outputDir" to dir))

        val sb = StringBuilder()
        Files.walk(outDir).use { stream ->
            stream.filter { it.toString().endsWith(".kt") }.sorted().forEach { p ->
                sb.append(Files.readString(p)).append('\n')
            }
        }
        allGenerated = sb.toString()
    }

    @AfterTest
    fun tearDown() {
        outDir.toFile().deleteRecursively()
    }

    private fun run(gen: Generator, args: Map<String, String>) {
        gen.setArgs(args)
        gen.execute(loader)
    }

    @Test
    fun twoDistinctlyNamedSourcesBothSurviveOnChildren() {
        val obj = loader.metaObjects.single { it.name.endsWith("::PhaseSummary") }
        val sources = obj.getChildren(RdbSource::class.java, true)
        assertEquals(
            listOf("primaryProc", "replicaView"),
            sources.map { it.name }.sorted(),
            "the divergence is only reachable while BOTH sources survive the child merge",
        )
    }

    @Test
    fun theGeneratorsEmitTheProcObjectAndNoTableObject() {
        // Ground truth: what the real generators actually wrote. Both select by role, so
        // the primary storedProc wins and the replica view contributes nothing.
        assertTrue(
            Files.exists(outDir.resolve("acme/demo/PhaseSummaryProc.kt")),
            "expected PhaseSummaryProc.kt; files=${Files.walk(outDir).toList()}",
        )
        assertFalse(
            Files.exists(outDir.resolve("acme/demo/PhaseSummaryTable.kt")),
            "the primary source is a storedProc, so no Exposed table object is emitted",
        )
    }

    @Test
    fun theDocumentedDataAccessSymbolIsTheOneTheGeneratorsEmit() {
        val model = KotlinApiModelBuilder().build(loader, PROJECT)
        val unit = model.units.single { it.node.endsWith("PhaseSummary") }
        val dataAccess = unit.symbols.filter { it.kind == ApiSymbolKind.DATA_ACCESS }

        assertEquals(
            listOf("PhaseSummaryProc"),
            dataAccess.map { it.name },
            "the docs must name the symbol the role-scoped generators emit, not the one the " +
                "first-DECLARED source would suggest",
        )
        // ...and the symbol it names is really in the generated source.
        assertTrue(
            "object PhaseSummaryProc" in allGenerated,
            "the documented data-access symbol must exist in the generated Kotlin",
        )
        assertFalse(
            "PhaseSummaryTable" in allGenerated,
            "guards the inverse: the wrongly-documented symbol is emitted by nothing",
        )
    }
}
