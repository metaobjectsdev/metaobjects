package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A column property named after a member of Exposed's `Table` gets a `Column` suffix
 * ([KotlinNaming.safeColumnProperty]), and WHICH names are members depends on the Exposed
 * version the output targets. `options` and `storageParameters` are `Table` properties only
 * in Exposed 1.x (checked with `javap` against exposed-core 0.55.0 and 1.3.1), so they are
 * reserved only under `exposedApi=1`: under 0.x a property of that name compiles, and
 * renaming it would change working generated code.
 */
class KotlinReservedTableMembersTest {

    private val model = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.entity": { "name": "Plan", "children": [
            { "source.rdb": { "@table": "plans" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "options" } },
            { "field.string": { "name": "storageParameters" } },
            { "field.string": { "name": "schemaName" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { "name": "by_options", "@fields": ["options"] } },
            { "measure.aggregate": { "name": "options", "@agg": "count", "@of": "Plan.id" } }
        ] } },
        { "object.report": { "name": "PlanTotals", "@from": "Plan", "@measures": ["options"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_plan_totals" } } ] } }
      ] }
    }"""

    private fun emit(exposedApi: String?, gen: Generator = KotlinExposedTableGenerator()): Map<String, String> {
        val outDir = Files.createTempDirectory("reserved-members-")
        try {
            val args = mapOf("outputDir" to outDir.toString(), "packageName" to "acme.shop") +
                (exposedApi?.let { mapOf("exposedApi" to it) } ?: emptyMap())
            gen.setArgs(args)
            gen.execute(loadString("reserved-members", model))
            return Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.toList().associate { outDir.relativize(it).toString() to it.readText() }
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the helper reserves the 1x-only members in 1x mode alone`() {
        for (name in listOf("options", "storageParameters")) {
            assertEquals(name, KotlinNaming.safeColumnProperty(name))
            assertEquals(name, KotlinNaming.safeColumnProperty(name, ExposedApi.V0))
            assertEquals(name + "Column", KotlinNaming.safeColumnProperty(name, ExposedApi.V1))
        }
        // A member of Table in both versions is reserved in both.
        for (api in ExposedApi.values()) {
            assertEquals("schemaNameColumn", KotlinNaming.safeColumnProperty("schemaName", api))
            assertEquals("sourceColumn", KotlinNaming.safeColumnProperty("source", api))
            assertEquals("title", KotlinNaming.safeColumnProperty("title", api))
        }
    }

    @Test
    fun `under Exposed 0x a field named options keeps its property name`() {
        for (api in listOf(null, "0")) {
            val table = emit(api).getValue("acme/shop/PlanTable.kt")
            assertTrue("    val options = text(\"options\").nullable()\n" in table, table)
            assertTrue("    val storageParameters = text(\"storage_parameters\").nullable()\n" in table, table)
            assertTrue("uniqueIndex(\"by_options\", options)" in table, table)
            assertFalse("optionsColumn" in table, table)
            assertFalse("storageParametersColumn" in table, table)
            // schemaName is a Table member in 0.x too.
            assertTrue("    val schemaNameColumn = text(\"schema_name\").nullable()\n" in table, table)
            val report = emit(api).getValue("acme/shop/PlanTotalsTable.kt")
            assertTrue("    val options = long(\"options\")\n" in report, report)
        }
    }

    @Test
    fun `under Exposed 1x a field named options gets the suffixed property, declared and referenced`() {
        val files = emit("1")
        val table = files.getValue("acme/shop/PlanTable.kt")
        // The physical column keeps its name; only the Kotlin property is renamed.
        assertTrue("    val optionsColumn = text(\"options\").nullable()\n" in table, table)
        assertTrue("    val storageParametersColumn = text(\"storage_parameters\").nullable()\n" in table, table)
        assertTrue("uniqueIndex(\"by_options\", optionsColumn)" in table, table)
        assertFalse("val options =" in table, table)
        assertTrue("    val schemaNameColumn = text(\"schema_name\").nullable()\n" in table, table)
        val report = files.getValue("acme/shop/PlanTotalsTable.kt")
        assertTrue("    val optionsColumn = long(\"options\")\n" in report, report)
    }

    @Test
    fun `the controller's sort dispatch references the property the table declares, per mode`() {
        val v0 = emit(null, KotlinSpringControllerGenerator()).values.joinToString("\n")
        assertTrue("\"options\" -> PlanTable.options\n" in v0, v0)
        val v1 = emit("1", KotlinSpringControllerGenerator()).values.joinToString("\n")
        assertTrue("\"options\" -> PlanTable.optionsColumn\n" in v1, v1)
    }
}
