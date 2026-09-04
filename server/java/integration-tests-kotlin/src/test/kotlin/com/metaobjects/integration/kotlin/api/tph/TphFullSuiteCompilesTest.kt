package com.metaobjects.integration.kotlin.api.tph

import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.generator.kotlin.KotlinValidatorGenerator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Table
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-017 TPH — compile-gate for the FULL codegen-kotlin generator suite over a discriminator
 * hierarchy that also owns a to-many composition. The codegen-kotlin unit snapshot test only
 * byte-compares, and its own [com.metaobjects.generator.kotlin.KotlinOutputCompilesTest] TPH case
 * runs the entity generator alone (no Exposed/Spring on that module's test classpath). So a
 * generated `<Sub>Table` / `<Sub>Relations` referencing a folded-away subtype table would slip past
 * both. This module HAS Exposed + Spring, so it compiles the whole emitted set:
 *
 * The `Auth` base owns `lines: many AuthLine`, inherited by every subtype. If any generator failed
 * to fold a subtype into the base — the table's back-FK inference (`buildGlobalFkMap`), the relations
 * helper, or the validator registry — it would emit a reference to a `BridgeAuthTable` /
 * `CopayAuthTable` / `PriorAuthAuthTable` that the table generator no longer emits, and this compile
 * would fail. `CopayAuth` also carries a non-discriminator `@filterable field.enum` (`tier`) that
 * folds into the union, so the TPH controller emits `castTo<String>(TextColumnType())` for it — this
 * gate also covers the #179 enum-filter import block on the TPH controller path.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class TphFullSuiteCompilesTest {

    private val tphWithCompositionFixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id", "@filterable": true } },
            { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay", "PriorAuth"] } },
            { "field.string": { "name": "reference", "@required": true, "@maxLength": 80, "@filterable": true } },
            { "relationship.composition": { "name": "lines", "@cardinality": "many", "@objectRef": "AuthLine", "@onDelete": "cascade" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true, "@filterable": true } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2, "@filterable": true } },
            { "field.enum":    { "name": "tier", "@values": ["Standard", "Premium"], "@filterable": true } }
        ] } },
        { "object.entity": { "name": "PriorAuthAuth", "extends": "Auth", "@discriminatorValue": "PriorAuth", "children": [
            { "field.string": { "name": "priorAuthNumber", "@maxLength": 80, "@filterable": true } }
        ] } },
        { "object.entity": { "name": "AuthLine", "children": [
            { "source.rdb":   { "@table": "auth_lines" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "@maxLength": 40 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `FR-017 full TPH generator suite with a composition compiles`() {
        val outDir = Files.createTempDirectory("tph-suite-")
        try {
            val loader = loadString("tph-suite", tphWithCompositionFixture)
            for (gen in listOf(
                KotlinEntityGenerator(),
                KotlinExposedTableGenerator(),
                KotlinSpringControllerGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinRelationsGenerator(),
                KotlinValidatorGenerator(),
            )) {
                val args = mutableMapOf("outputDir" to outDir.toString())
                if (gen is KotlinValidatorGenerator) args["packageName"] = "acme.auth.validation"
                gen.setArgs(args)
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val names = emitted.map { it.fileName.toString() }.toSet()
            // The subtypes fold into the base — no per-subtype persistence artifact of any kind.
            for (dead in listOf(
                "BridgeAuthTable.kt", "CopayAuthTable.kt", "PriorAuthAuthTable.kt",
                "BridgeAuthRelations.kt", "CopayAuthRelations.kt", "PriorAuthAuthRelations.kt",
            )) {
                assertFalse(dead in names, "TPH subtype must not emit $dead; got $names")
            }

            val sources = emitted.map { path ->
                SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "TPH full generator suite (with composition) failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `FR-017 full TPH generator suite with the names artifact in the run compiles and folds the subtype columns`() {
        // Task 6 — the names-ON arm. The base's AuthTable references `<Sub>Names.<COL>_COLUMN`
        // for every SUBTYPE column it folds in (quantity / copayAmount / tier / priorAuthNumber
        // belong to the subtypes' artifacts, not AuthNames). A text assertion proves the
        // reference is SPELLED; only the compiler proves it RESOLVES, and only the compiled
        // Exposed object proves it folds to the column the database has.
        val outDir = Files.createTempDirectory("tph-suite-names-")
        try {
            val loader = loadString("tph-suite-names", tphWithCompositionFixture)
            for (gen in listOf(
                KotlinEntityGenerator(),
                KotlinNamesGenerator(),
                KotlinExposedTableGenerator(),
                KotlinSpringControllerGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinRelationsGenerator(),
                KotlinValidatorGenerator(),
            )) {
                val args = mutableMapOf("outputDir" to outDir.toString(), "useNames" to "true")
                if (gen is KotlinValidatorGenerator) args["packageName"] = "acme.auth.validation"
                gen.setArgs(args)
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val authTable = emitted.first { it.fileName.toString() == "AuthTable.kt" }.readText()
            assertTrue("integer(BridgeAuthNames.QUANTITY_COLUMN).nullable()" in authTable, authTable)
            assertTrue("decimal(CopayAuthNames.COPAY_AMOUNT_COLUMN, 10, 2).nullable()" in authTable, authTable)
            assertTrue("varchar(PriorAuthAuthNames.PRIOR_AUTH_NUMBER_COLUMN, 80).nullable()" in authTable, authTable)
            assertTrue("enumerationByName(CopayAuthNames.TIER_COLUMN, 64, AuthTier::class).nullable()" in authTable, authTable)

            val sources = emitted.map { path ->
                SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "TPH full generator suite (names ON) failed to compile:\n${result.messages}")

            // The compiled Exposed object carries the folded columns under the names the
            // subtypes' artifacts declare — the references folded to the right strings.
            val table = result.classLoader.loadClass("acme.auth.AuthTable").getDeclaredField("INSTANCE").get(null) as Table
            assertEquals("auths", table.tableName)
            val columns = table.columns.map { it.name }.toSet()
            for (col in listOf("id", "type", "reference", "quantity", "copay_amount", "tier", "prior_auth_number")) {
                assertTrue(col in columns, "AuthTable is missing column $col; has $columns")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
