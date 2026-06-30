package com.metaobjects.integration.kotlin

import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.loader.MetaDataLoader
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Structural-match test: run [KotlinExposedTableGenerator] against the shared
 * persistence-conformance canonical metadata and assert each emitted Table file
 * contains the column declarations a hand-written reference Table would have.
 *
 * Why structural (not byte-equal): the generator currently emits some columns
 * with subtly different surface syntax than this module's reference Tables
 * (e.g. `instantWithTimeZone(...)` vs `datetime(...)`, with-imports vs
 * without-imports). Asserting on column NAME + base type FAMILY (`long`,
 * `varchar`, `datetime`/`instantWithTimeZone`) catches the regressions worth catching here
 * (a missing column, a wrong PK, a renamed table) without coupling to those
 * intentional codegen choices. Snapshot-byte equality for the generator's
 * exact output lives in `codegen-kotlin`'s own KotlinCodegenSnapshotTest.
 */
internal class KotlinCodegenMatchesReferenceTest {

    /** Expected `val <name> = <columnFamily>(...)` declarations per entity. */
    private val expectations: Map<String, EntityExpectation> = mapOf(
        "Program" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("long")),
                ExpectedColumn("title", families = setOf("varchar")),
                ExpectedColumn("priceCents", families = setOf("long")),
                ExpectedColumn("status", families = setOf("varchar", "enumerationByName")),
                // Plain `field.timestamp` (no @dbColumnType) → Exposed `datetime(...)` (Postgres
                // `timestamp without time zone`, LocalDateTime). The TZ-aware opt-in is covered by
                // Asset.recordedAt below.
                ExpectedColumn("createdAt", families = setOf("datetime")),
            ),
        ),
        "Week" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("long")),
                ExpectedColumn("programId", families = setOf("long")),
                ExpectedColumn("label", families = setOf("varchar")),
            ),
            // Week declares `identity.reference @fields="programId" @references="Program"`
            // on the canonical fixture — the generated WeekTable must carry the
            // matching FK constraint on its programId column.
            foreignKeys = listOf(
                ExpectedFk(columnName = "programId", targetTable = "ProgramTable"),
            ),
        ),
        // R6 float fidelity: field.float → Exposed `float(...)` (REAL),
        // field.double → `double(...)` (DOUBLE PRECISION). SP-A: field.decimal →
        // `decimal(...)` (NUMERIC, exact precision). Verifies the generator emits the
        // distinct single/double-precision + exact-decimal column families.
        "Measurement" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("long")),
                ExpectedColumn("tempC", families = setOf("float")),
                ExpectedColumn("massKg", families = setOf("double")),
                ExpectedColumn("preciseKg", families = setOf("decimal")),
            ),
        ),
        "ProgramView" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("long")),
                // `ProgramView.title` is a `origin.passthrough` projection field with NO own
                // `@maxLength` (the passthrough does not carry the source field's maxLength), so
                // Phase 1 (dbColumnType slim-and-derive) derives `text(...)` — the no-maxLength
                // string default — not the old `varchar(255)`. The view's DDL is TS-canonical-owned;
                // this Exposed mapping is read-only.
                ExpectedColumn("title", families = setOf("text")),
                ExpectedColumn("status", families = setOf("varchar", "enumerationByName")),
            ),
        ),
        "ProgramStat" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programId", families = setOf("long")),
                ExpectedColumn("weekCount", families = setOf("long")),
            ),
        ),
        // R6 Plan 2a/2b native physical column types: field.uuid → Exposed `uuid(...)`,
        // field.string + @dbColumnType:uuid → `uuid(...)`, field.string + @dbColumnType:jsonb
        // → `jsonb(...)` (NOT text), default field.timestamp (instant/TZ-aware, ADR-0036 Wave 2) →
        // `instantWithTimeZone(...)` (a file-local Column<Instant> with TIMESTAMP WITH TIME ZONE
        // DDL — matches the Instant data class, NOT the native OffsetDateTime variant). Verifies
        // the generator emits the native families the hand-written reference AssetTable carries.
        "Asset" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("uuid")),
                ExpectedColumn("ownerId", families = setOf("uuid")),
                ExpectedColumn("externalId", families = setOf("uuid")),
                ExpectedColumn("payload", families = setOf("jsonb")),
                ExpectedColumn("recordedAt", families = setOf("instantWithTimeZone")),
            ),
        ),
    )

    @Test
    fun `codegen-kotlin emits the canonical entities with the expected column declarations`() {
        val corpus = ScenarioLoader.findCorpusRoot()
        val canonicalDir = corpus.resolve("canonical")

        val loader = MetaDataLoader.fromDirectory("ktx-codegen-matches", canonicalDir)
        val outDir = Files.createTempDirectory("ktx-codegen-matches-").toFile()
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.absolutePath))
            gen.execute(loader)

            for ((entity, expected) in expectations) {
                val tableFile = findEmittedTableFile(outDir, "${entity}Table.kt")
                    ?: fail("Generator did not emit '${entity}Table.kt' under ${outDir.absolutePath}")
                val source = tableFile.readText()
                assertSourceContainsColumns(entity, source, expected.columns)
                assertSourceContainsForeignKeys(entity, source, expected.foreignKeys)
            }
        } finally {
            outDir.deleteRecursively()
        }
    }

    private fun findEmittedTableFile(root: File, filename: String): File? =
        root.walkTopDown().firstOrNull { it.isFile && it.name == filename }

    private fun assertSourceContainsColumns(entity: String, source: String, expected: List<ExpectedColumn>) {
        for (col in expected) {
            val matched = col.families.any { family ->
                // Match patterns like `val priceCents = long(...)` or
                // `val status = enumerationByName(...)` allowing the codegen
                // to refine the column type surface without breaking this test.
                Regex("""\bval\s+${Regex.escape(col.name)}\s*=\s*${Regex.escape(family)}\s*\(""")
                    .containsMatchIn(source)
            }
            assertTrue(
                matched,
                "${entity}Table.kt: expected `val ${col.name} = <${col.families.joinToString("|")}>(...)`. " +
                    "Source was:\n$source"
            )
        }
    }

    /**
     * Assert each expected FK is present as a `.references(<TargetTable>.id...)`
     * decoration on the named column. Catches the regression where the generator
     * silently drops the FK constraint (e.g. ignoring `identity.reference`).
     */
    private fun assertSourceContainsForeignKeys(
        entity: String,
        source: String,
        expected: List<ExpectedFk>,
    ) {
        for (fk in expected) {
            // Match: `val <columnName> = <anyType>("...")[...].references(<TargetTable>.id...)`
            // Allows the type/length surface and intermediate calls to vary without coupling.
            val pattern = Regex(
                """\bval\s+${Regex.escape(fk.columnName)}\s*=\s*[^\n]*\.references\s*\(\s*${Regex.escape(fk.targetTable)}\s*\.\s*id\b"""
            )
            assertTrue(
                pattern.containsMatchIn(source),
                "${entity}Table.kt: expected FK on column '${fk.columnName}' → ${fk.targetTable}.id; saw:\n$source",
            )
        }
    }

    private data class ExpectedColumn(val name: String, val families: Set<String>)
    private data class ExpectedFk(val columnName: String, val targetTable: String)
    private data class EntityExpectation(
        val columns: List<ExpectedColumn>,
        val foreignKeys: List<ExpectedFk> = emptyList(),
    )
}
