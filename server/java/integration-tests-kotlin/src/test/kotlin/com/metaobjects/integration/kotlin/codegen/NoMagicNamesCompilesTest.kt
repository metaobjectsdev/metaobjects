package com.metaobjects.integration.kotlin.codegen

import com.metaobjects.generator.EmitsPhysicalNameConstants
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.generator.kotlin.KotlinStoredProcGenerator
import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Table
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * NO MAGIC STRINGS — the compile half. `codegen-kotlin`'s `NoMagicPhysicalNamesTest` proves
 * that, with the names artifact in the run, no generated file SPELLS a physical name a second
 * time; it is a text gate and cannot see whether the references it demands RESOLVE. That
 * module has no Exposed on its test classpath, so it cannot compile a `*Table.kt` or a
 * `*Proc.kt`. This module can, and this test compiles the three shapes whose references were
 * added last — the shapes the text gate found spelling literals — and then reads the compiled
 * constants back out, so the claim is not "the source says `CarNames.DOORS_COLUMN`" but "the
 * table the JVM built has a column called `zz_phys_col_doors`".
 *
 *  - TPH: the base's table folds a same-package subtype's column, a CROSS-PACKAGE subtype's
 *    column (a package-qualified reference), and a column declared on an ABSTRACT
 *    intermediate — each referenced on its DECLARING entity's artifact.
 *  - Write-through: ONE entity, TWO physical names. The write table references
 *    `<Entity>Names.SOURCE_PRIMARY_TABLE` and the replica view
 *    `<Entity>Names.SOURCE_REPLICA_VIEW` — the artifact keys its sources by `@role`, so the
 *    view stopped being the one literal this model expected. Both must compile side by side
 *    AND fold to two DIFFERENT names, which is what the two `tableName` assertions below
 *    check: a role key that always resolved to `primary` would compile just as well and bind
 *    the read object to the write table.
 *  - Stored procedure: `PROC_NAME` is a `const val` initialised FROM
 *    `<Entity>Names.SOURCE_PRIMARY_PROC` (the alias for the source's `@kind` — the artifact
 *    no longer has one `NAME` member meaning a table, a view or a procedure by turns), and
 *    each result column is read through `<Entity>Names.<MEMBER>_COLUMN`.
 *
 * Every physical name is `zz_phys_`-prefixed and unrelated to its logical name, exactly as in
 * the text gate, so a generator that re-derived a name could not pass by coincidence.
 *
 * `useNames` is DERIVED through the shipped [EmitsPhysicalNameConstants.deriveUseNames] — the
 * identical call the Maven mojo makes — rather than hand-set, so this gate also exercises the
 * mechanism a real build turns the substitution on with. The loader is STRICT, as the mojo's
 * default is, so the model below is also proven to be registered vocabulary only.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class NoMagicNamesCompilesTest {

    private val fleet = """{
      "metadata.root": { "package": "acme::fleet", "children": [
        { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
            { "source.rdb":   { "@table": "zz_phys_tbl_veh" } },
            { "field.long":   { "name": "id",   "@column": "zz_phys_col_vid", "@filterable": true } },
            { "field.enum":   { "name": "kind", "@column": "zz_phys_col_kind", "@values": ["Car", "Truck"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Wheeled", "abstract": true, "extends": "Vehicle", "children": [
            { "field.int": { "name": "wheels", "@column": "zz_phys_col_wheels" } }
        ] } },
        { "object.entity": { "name": "Car", "extends": "Wheeled", "@discriminatorValue": "Car", "children": [
            { "field.int":  { "name": "doors", "@column": "zz_phys_col_doors" } },
            { "field.enum": { "name": "grade", "@column": "zz_phys_col_grad", "@values": ["LO", "HI"] } }
        ] } },
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb": { "@table": "zz_phys_tbl_delta", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "zz_phys_view_delta", "@role": "replica" } },
            { "field.long": { "name": "id", "@column": "zz_phys_col_acct" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.value": { "name": "ProcArgs", "children": [
            { "field.long": { "name": "since", "@column": "zz_phys_col_since" } }
        ] } },
        { "object.projection": { "name": "ProcOut", "children": [
            { "source.rdb":   { "@kind": "storedProc", "@proc": "zz_phys_proc_alpha", "@parameterRef": "ProcArgs" } },
            { "field.long":   { "name": "total", "@column": "zz_phys_col_total" } },
            { "field.string": { "name": "label", "@column": "zz_phys_col_lbl" } }
        ] } }
      ] }
    }""".trimIndent()

    /** A second file in ANOTHER package, contributing a subtype of `acme::fleet::Vehicle`. */
    private val haulage = """{
      "metadata.root": { "package": "acme::haulage", "children": [
        { "object.entity": { "name": "Truck", "extends": "acme::fleet::Vehicle", "@discriminatorValue": "Truck", "children": [
            { "field.int": { "name": "payload", "@column": "zz_phys_col_load" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `TPH fold, write-through table and stored-proc wrapper compile against the names artifact and fold to the physical names`() {
        val outDir = Files.createTempDirectory("no-magic-compiles-")
        try {
            val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "no-magic-compiles")
            loader.init()
            loader.load(listOf(
                InMemoryStringSource(fleet, "fleet.json", MetaDataFormat.JSON),
                InMemoryStringSource(haulage, "haulage.json", MetaDataFormat.JSON),
            ))
            loader.register()
            assertEquals(emptyList(), loader.errors.map { it.message }, "the model must load clean under a STRICT load")

            val suite = listOf(
                KotlinEntityGenerator(),
                KotlinNamesGenerator(),
                KotlinExposedTableGenerator(),
                KotlinStoredProcGenerator(),
                KotlinRelationsGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(),
            )
            val args = EmitsPhysicalNameConstants.deriveUseNames(mapOf("outputDir" to outDir.toString()), suite)
            assertEquals("true", args["useNames"], "the names generator is in the suite, so the derivation must turn the substitution on")
            for (gen in suite) {
                gen.setArgs(args)
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            // The text half, on this model: no file but a names artifact spells a physical name.
            val leaks = emitted
                .filter { !it.fileName.toString().endsWith("Names.kt") }
                .flatMap { p -> Regex("""zz_phys_\w+""").findAll(p.readText()).map { m -> "${outDir.relativize(p)}: ${m.value}" }.toList() }
                .sorted()
            // ZERO, as of the 0.25.0 restructure. This list held exactly one entry —
            // `AccountView.kt: zz_phys_view_delta` — because `<Entity>Names` carried the
            // PRIMARY source's physical name and nothing else, so the replica view had
            // nothing to reference. Keying sources by @role gave it `SOURCE_REPLICA_VIEW`.
            assertEquals(emptyList(), leaks)

            val sources = emitted.map { path ->
                SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated output referencing the names artifact failed to compile:\n${result.messages}")

            // The compile half: what the JVM actually built.
            fun table(fqcn: String): Table =
                result.classLoader.loadClass(fqcn).getDeclaredField("INSTANCE").get(null) as Table

            // TPH: the base's table, with every folded subtype column under its physical name.
            val vehicle = table("acme.fleet.VehicleTable")
            assertEquals("zz_phys_tbl_veh", vehicle.tableName)
            val vehicleCols = vehicle.columns.map { it.name }.toSet()
            for (col in listOf(
                "zz_phys_col_vid", "zz_phys_col_kind",   // the base's own
                "zz_phys_col_doors", "zz_phys_col_grad", // a same-package subtype's, both fold arms
                "zz_phys_col_load",                      // a cross-package subtype's (package-qualified reference)
                "zz_phys_col_wheels",                    // declared on an abstract intermediate
            )) {
                assertTrue(col in vehicleCols, "VehicleTable is missing $col; has $vehicleCols")
            }

            // Write-through: each object folds its OWN role's constant. Both assertions
            // together are the teeth — the second alone would pass on a literal, and the
            // first alone would pass on a role key stuck at `primary`.
            assertEquals("zz_phys_tbl_delta", table("acme.fleet.AccountTable").tableName)
            assertEquals("zz_phys_view_delta", table("acme.fleet.AccountView").tableName)
            assertEquals(setOf("zz_phys_col_acct"), table("acme.fleet.AccountTable").columns.map { it.name }.toSet())

            // Stored procedure: PROC_NAME folded from ProcOutNames.SOURCE_PRIMARY_PROC to
            // the physical name.
            val proc = result.classLoader.loadClass("acme.fleet.ProcOutProc")
            assertEquals("zz_phys_proc_alpha", proc.getField("PROC_NAME").get(null))
            // ...and the result-row getters read the physical columns (the wrapper's source
            // carries the constant references; the artifact they fold from carries the names).
            val procSrc = emitted.first { it.fileName.toString() == "ProcOutProc.kt" }.readText()
            assertTrue("const val PROC_NAME = ProcOutNames.SOURCE_PRIMARY_PROC" in procSrc, procSrc)
            assertTrue("total = rs.getLong(ProcOutNames.TOTAL_COLUMN)" in procSrc, procSrc)
            assertTrue("label = rs.getString(ProcOutNames.LABEL_COLUMN)" in procSrc, procSrc)
            val names = result.classLoader.loadClass("acme.fleet.ProcOutNames")
            assertEquals("zz_phys_col_total", names.getField("TOTAL_COLUMN").get(null))
            assertEquals("zz_phys_col_lbl", names.getField("LABEL_COLUMN").get(null))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
