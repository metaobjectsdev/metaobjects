package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #246 Bug 1 — [KotlinExposedTableGenerator] dropped the cross-package import for a shared
 * `field.enum` (FR-019 collapse): the `enumerationByName("...", LEN, <Name>::class)` column
 * token used only the enum's simple name (via [KotlinTypeMapper.enumTypeName]?.simpleName),
 * discarding the package the shared enum class actually lives in. [KotlinEntityGenerator]'s
 * data class never showed the bug because KotlinPoet auto-imports the full `ClassName` it is
 * handed; this generator hand-rolls its file body as a string (see class kdoc) and must add the
 * import itself.
 *
 * Loads the shared `fixtures/codegen-conformance/enum-xpkg/input/` fixture: an abstract
 * `field.enum RecordStatus` declared in `acme::common`, and two entities in DIFFERENT packages
 * (`acme::orders::Order`, `acme::billing::Invoice`) whose `status` field `extends` it — so both
 * generated tables reference the ONE shared `acme.common.RecordStatus` enum class.
 *
 * The fixture also covers the TPH-fold path (FR-017 discriminator): `acme::shipping::Shipment`
 * is a discriminator base whose SUBTYPE `AirShipment` declares a subtype-only `recordStatus`
 * field that `extends` the SAME cross-package `acme::common::RecordStatus`. The subtype field is
 * folded into the base's single table via [KotlinTphPlan.collectSubtypeFields] — a SEPARATE
 * code path from the vanilla own-field loop above, with its own import-collection walk, that a
 * base-only-enum TPH fixture (every other TPH fixture in this module) never exercises.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExposedTableCrossPackageEnumTest {

    private val corpus: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/codegen-conformance"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate fixtures/codegen-conformance from user.dir")
        p!!.resolve("fixtures/codegen-conformance")
    }

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    private fun readGenerated(outDir: Path, relative: String): String {
        val file = outDir.resolve(relative)
        assertTrue(Files.exists(file), "expected generated file $file; files=${Files.walk(outDir).toList()}")
        return file.readText()
    }

    @Test fun `table generator imports a cross-package shared enum`() {
        val outDir = Files.createTempDirectory("ktbl-xpkg-enum-")
        try {
            val loader = loadDirectory("enum-xpkg", corpus.resolve("enum-xpkg/input"))

            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // The shared enum class itself lands in the SUPER's package (acme.common).
            val recordStatus = readGenerated(outDir, "acme/common/RecordStatus.kt")
            assertTrue("enum class RecordStatus" in recordStatus, recordStatus)

            // OrderTable.kt is generated in package acme.orders and references the shared enum.
            val orderTable = readGenerated(outDir, "acme/orders/OrderTable.kt")
            assertTrue(orderTable.contains("import acme.common.RecordStatus"),
                "OrderTable must import the cross-package shared enum; saw:\n$orderTable")
            assertTrue(orderTable.contains("RecordStatus::class"),
                "OrderTable still references the enum in enumerationByName; saw:\n$orderTable")

            val invoiceTable = readGenerated(outDir, "acme/billing/InvoiceTable.kt")
            assertTrue(invoiceTable.contains("import acme.common.RecordStatus"),
                "InvoiceTable must import the cross-package shared enum; saw:\n$invoiceTable")
            assertTrue(invoiceTable.contains("RecordStatus::class"),
                "InvoiceTable still references the enum in enumerationByName; saw:\n$invoiceTable")

            // TPH-fold path: the base ShipmentTable.kt (NOT AirShipmentTable — TPH subtypes emit
            // no table of their own) must carry the import for the SUBTYPE-only cross-package
            // enum folded into its single table.
            val shipmentTable = readGenerated(outDir, "acme/shipping/ShipmentTable.kt")
            assertTrue(shipmentTable.contains("import acme.common.RecordStatus"),
                "TPH-folded ShipmentTable must import the cross-package shared enum; saw:\n$shipmentTable")
            assertTrue(shipmentTable.contains("val recordStatus = enumerationByName(\"record_status\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, RecordStatus::class).nullable()"),
                "TPH-folded status column must reference the shared enum; saw:\n$shipmentTable")
            assertTrue(!Files.exists(outDir.resolve("acme/shipping/AirShipmentTable.kt")),
                "a TPH subtype must NOT emit its own table")

            // Compile-gate: the whole generated tree must compile (catches any import variant).
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
