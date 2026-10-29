package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.RunAware
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #484: a report column is DERIVED from its `@of` field, so it would lose the field's `view.password` and be
 * served. A grouped or min/max-ed credential stays a credential: the report's list route omits the key and
 * its export names no column for it, as an entity's routes do. A report with no credential source is unchanged.
 */
class KotlinReportCredentialTest {

    private val model = """{
      "metadata.root": { "package": "acme::acct", "children": [
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb":   { "@table": "accounts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 40 } },
            { "field.string": { "name": "pinHash", "@maxLength": 80, "children": [ { "view.password": {} } ] } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } },
            { "dimension.attribute": { "name": "name", "@of": "Account.name" } },
            { "dimension.attribute": { "name": "pinHash", "@of": "Account.pinHash" } },
            { "measure.aggregate": { "name": "accounts", "@agg": "count", "@of": "Account.id" } },
            { "measure.aggregate": { "name": "firstPin", "@agg": "min", "@of": "Account.pinHash" } }
        ] } },
        { "object.report": { "name": "AccountsByPin", "@from": "Account", "@dimensions": ["pinHash"], "@measures": ["accounts"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_pin" } } ] } },
        { "object.report": { "name": "AccountPinRange", "@from": "Account", "@dimensions": ["name"], "@measures": ["firstPin"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_account_pin_range" } } ] } },
        { "object.report": { "name": "AccountsByName", "@from": "Account", "@dimensions": ["name"], "@measures": ["accounts"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_name" } } ] } }
      ] }
    }""".trimIndent()

    private fun generate(): Map<String, String> {
        val outDir = Files.createTempDirectory("report-credential-")
        try {
            val loader = loadString("report-credential", model)
            val run: List<Generator> = listOf(
                KotlinEntityGenerator(), KotlinExposedTableGenerator(), KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(), KotlinReportExportGenerator(),
            )
            for (gen in run) {
                if (gen is RunAware) gen.setRun(run)
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val files = TreeMap<String, String>()
            Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.forEach { files[outDir.relativize(it).toString()] = it.readText() }
            }
            return files
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun file(files: Map<String, String>, suffix: String): String =
        files.entries.firstOrNull { it.key.endsWith(suffix) }?.value ?: error("no $suffix in ${files.keys}")

    @Test
    fun `a report over a credential dimension omits it from its rows and export`() {
        val files = generate()
        val controller = file(files, "AccountsByPinController.kt")
        assertTrue("remove(listOf(\"pinHash\"))" in controller, controller)
        assertTrue("redactAccountsByPin(objectMapper, rowToAccountsByPin(it))" in controller, controller)
        assertTrue("rows.map { redactAccountsByPin(objectMapper, it) }" in controller, controller)
        val export = file(files, "AccountsByPinExport.kt")
        assertFalse("pinHash" in export, export)
        assertTrue("accounts" in export, export)
    }

    @Test
    fun `a min measure over a credential is a credential too`() {
        val files = generate()
        val controller = file(files, "AccountPinRangeController.kt")
        assertTrue("remove(listOf(\"firstPin\"))" in controller, controller)
        val export = file(files, "AccountPinRangeExport.kt")
        assertFalse("firstPin" in export, export)
        assertTrue("\"name\"" in export, export)
    }

    @Test
    fun `a report with no credential source is served unredacted`() {
        val files = generate()
        val controller = file(files, "AccountsByNameController.kt")
        assertFalse("redact" in controller, controller)
        assertFalse("ObjectMapper" in controller, controller)
        assertTrue("\"name\"" in file(files, "AccountsByNameExport.kt"))
    }

    @Test
    fun `a credential column is neither filterable nor sortable`() {
        val files = generate()
        for ((report, col) in listOf("AccountsByPin" to "pinHash", "AccountPinRange" to "firstPin")) {
            val allowlist = file(files, "${report}FilterAllowlist.kt")
            assertFalse("\"$col\"" in allowlist, allowlist)
            val controller = file(files, "${report}Controller.kt")
            // the sort parser knows no such column, so ?sort=<col> is refused as invalid_sort
            val sortSurface = controller.substringAfter("${report}SortAllowlist = setOf(").substringBefore("\n)\n")
            assertFalse("\"$col\"" in sortSurface, sortSurface)
            assertTrue("\"name\"" in sortSurface || "\"accounts\"" in sortSurface, sortSurface)
        }
        // the report's other columns and a plain report keep theirs
        assertTrue("\"accounts\"" in file(files, "AccountsByPinFilterAllowlist.kt"))
        assertTrue("\"name\"" in file(files, "AccountsByNameFilterAllowlist.kt"))
        assertTrue("\"name\"" in file(files, "AccountPinRangeFilterAllowlist.kt"))
    }
}
