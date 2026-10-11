package com.metaobjects.integration.kotlin

import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.integration.kotlin.tables.ReportViews
import com.metaobjects.loader.MetaDataLoader
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
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
        // field.string + @dbColumnType:jsonb → `jsonb(...)` (NOT text), default field.timestamp
        // (instant/TZ-aware, ADR-0036 Wave 2) → `instantWithTimeZone(...)` (a file-local
        // Column<Instant> with TIMESTAMP WITH TIME ZONE DDL — matches the Instant data class,
        // NOT the native OffsetDateTime variant). field.string + @dbColumnType:uuid →
        // `uuidString(...)` — a package-shared `Column<String>` over the native Postgres uuid
        // type (NOT a bare `uuid(...)` `Column<UUID>`: ADR-0037 keeps the escape hatch's logical
        // type `String`, matching the generated entity/controller — found fixing
        // AssetController.kt's pre-existing compile defect, see KotlinExposedTableGenerator's
        // `uuidStringSupportBlock`). Verifies the generator emits the native families the
        // hand-written reference AssetTable carries for id/ownerId/payload/recordedAt (AssetTable
        // itself intentionally still uses native `uuid("externalId")` for its OWN purpose — the
        // SP-H roundtrip harness reads/normalizes a `java.util.UUID` directly and never passes
        // through a generated String-typed entity, so there is no mismatch for it to hold).
        "Asset" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("id", families = setOf("uuid")),
                ExpectedColumn("ownerId", families = setOf("uuid")),
                ExpectedColumn("externalId", families = setOf("uuidString")),
                ExpectedColumn("payload", families = setOf("jsonb")),
                ExpectedColumn("recordedAt", families = setOf("instantWithTimeZone")),
            ),
        ),
        // FR-044: the twenty-three view-backed reports. Each mirrors its hand-written reference
        // (`tables/<Report>View.kt`) column for column: the family is the view's real column
        // type, and a column is nullable exactly when the reference's is. A report has no
        // identity, so none carries a primary key.
        "ProgramMinutes" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("program", families = setOf("long"), nullable = false),
                ExpectedColumn("programTitle", families = setOf("varchar"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("longWeeks", families = setOf("long"), nullable = false),
                ExpectedColumn("labels", families = setOf("long"), nullable = false),
                ExpectedColumn("slots", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMinutes", families = setOf("long"), nullable = true),
                ExpectedColumn("avgMinutes", families = setOf("decimal"), nullable = true),
                ExpectedColumn("minMinutes", families = setOf("integer"), nullable = true),
                ExpectedColumn("maxMinutes", families = setOf("integer"), nullable = true),
                ExpectedColumn("longShare", families = setOf("decimal"), nullable = true),
            ),
            report = "v_program_minutes",
        ),
        "FitnessTotals" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMinutes", families = setOf("long"), nullable = true),
                ExpectedColumn("longShare", families = setOf("decimal"), nullable = true),
            ),
            report = "v_fitness_totals",
        ),
        "ProgramsByMonth" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("createdAtMonth", families = setOf("date"), nullable = false),
                ExpectedColumn("status", families = setOf("varchar", "enumerationByName"), nullable = false),
                ExpectedColumn("programs", families = setOf("long"), nullable = false),
                ExpectedColumn("listValue", families = setOf("long"), nullable = true),
            ),
            report = "v_programs_by_month",
        ),
        "ProgramsByWeek" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("createdAtWeek", families = setOf("date"), nullable = false),
                ExpectedColumn("programs", families = setOf("long"), nullable = false),
            ),
            report = "v_programs_by_week",
        ),
        "RecentPrograms" to EntityExpectation(
            columns = listOf(ExpectedColumn("programs", families = setOf("long"), nullable = false)),
            report = "v_recent_programs",
        ),
        "AssetActivity" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("recordedAtHour", families = setOf("instantWithTimeZone"), nullable = false),
                ExpectedColumn("asOfDateWeek", families = setOf("date"), nullable = false),
                ExpectedColumn("assets", families = setOf("long"), nullable = false),
            ),
            report = "v_asset_activity",
        ),
        // `@spine` and a measure's `@default` (contract Table C): under @spine a column of the
        // spine entity that is its key or `@required` is non-null, and a measure with
        // `@default` is non-null; the same measure without it stays nullable.
        "ProgramRoster" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programKey", families = setOf("long"), nullable = false),
                ExpectedColumn("programTitle", families = setOf("varchar"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMinutes", families = setOf("long"), nullable = true),
                ExpectedColumn("totalMinutesOrZero", families = setOf("long"), nullable = false),
                ExpectedColumn("longShare", families = setOf("decimal"), nullable = true),
                ExpectedColumn("longShareOrZero", families = setOf("decimal"), nullable = false),
            ),
            report = "v_program_roster",
        ),
        "ProgramLongWeeks" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programKey", families = setOf("long"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMinutesOrZero", families = setOf("long"), nullable = false),
            ),
            report = "v_program_long_weeks",
        ),
        // `@agg: any` / `all`: a BOOLEAN measure, nullable unless it declares `@default`.
        "ProgramFlags" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("program", families = setOf("long"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("anyDeload", families = setOf("bool"), nullable = true),
                ExpectedColumn("allDeload", families = setOf("bool"), nullable = true),
                ExpectedColumn("anyLongDeload", families = setOf("bool"), nullable = true),
            ),
            report = "v_program_flags",
        ),
        "ProgramFlagRoster" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programKey", families = setOf("long"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("anyDeload", families = setOf("bool"), nullable = true),
                ExpectedColumn("anyDeloadOrFalse", families = setOf("bool"), nullable = false),
                ExpectedColumn("allDeloadOrTrue", families = setOf("bool"), nullable = false),
            ),
            report = "v_program_flag_roster",
        ),
        "FitnessTotalsFilled" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMinutesOrZero", families = setOf("long"), nullable = false),
                ExpectedColumn("longShareOrZero", families = setOf("decimal"), nullable = false),
            ),
            report = "v_fitness_totals_filled",
        ),
        // Reports for the vocabulary the first eleven do not reach (numeric, temporal, boolean/uuid/
        // int-enum dimensions, multi-hop and self-reference paths, an empty scope).
        "MeasurementStats" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("readings", families = setOf("long"), nullable = false),
                ExpectedColumn("totalMassKg", families = setOf("double"), nullable = true),
                ExpectedColumn("avgMassKg", families = setOf("double"), nullable = true),
                ExpectedColumn("maxTempC", families = setOf("float"), nullable = true),
                ExpectedColumn("minTempC", families = setOf("float"), nullable = true),
                ExpectedColumn("totalPreciseKg", families = setOf("decimal"), nullable = true),
                ExpectedColumn("avgPreciseKg", families = setOf("decimal"), nullable = true),
                ExpectedColumn("maxPreciseKg", families = setOf("decimal"), nullable = true),
                ExpectedColumn("heavyReadings", families = setOf("long"), nullable = false),
            ),
            report = "v_measurement_stats",
        ),
        "MeasurementStatsFilled" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("readings", families = setOf("long"), nullable = false),
                ExpectedColumn("avgPreciseKgOrMinusOne", families = setOf("decimal"), nullable = false),
                ExpectedColumn("maxPreciseKgOrZero", families = setOf("decimal"), nullable = false),
            ),
            report = "v_measurement_stats_filled",
        ),
        "AssetDays" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("recordedAtDay", families = setOf("date"), nullable = false),
                ExpectedColumn("asOfDateMonth", families = setOf("date"), nullable = false),
                ExpectedColumn("assets", families = setOf("long"), nullable = false),
                ExpectedColumn("owners", families = setOf("long"), nullable = false),
                ExpectedColumn("firstRecorded", families = setOf("instantWithTimeZone"), nullable = true),
                ExpectedColumn("lastObserved", families = setOf("datetime"), nullable = true),
                ExpectedColumn("lastAsOf", families = setOf("date"), nullable = true),
            ),
            report = "v_asset_days",
        ),
        "AllTypesBreakdown" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("flag", families = setOf("bool"), nullable = false),
                ExpectedColumn("level", families = setOf("varchar", "enumerationByName"), nullable = false),
                ExpectedColumn("legacyStatus", families = setOf("customEnumeration"), nullable = true),
                ExpectedColumn("dateKey", families = setOf("date"), nullable = false),
                ExpectedColumn("uuidKey", families = setOf("uuid"), nullable = false),
                ExpectedColumn("allRows", families = setOf("long"), nullable = false),
                ExpectedColumn("totalInts", families = setOf("long"), nullable = true),
                ExpectedColumn("avgDec", families = setOf("decimal"), nullable = true),
                ExpectedColumn("maxMoney", families = setOf("long"), nullable = true),
                ExpectedColumn("minLong", families = setOf("long"), nullable = true),
                ExpectedColumn("highRows", families = setOf("long"), nullable = false),
            ),
            report = "v_all_types_breakdown",
        ),
        "ProgramsOverTime" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("createdAtDay", families = setOf("date"), nullable = false),
                ExpectedColumn("createdAtQuarter", families = setOf("date"), nullable = false),
                ExpectedColumn("createdAtYear", families = setOf("date"), nullable = false),
                ExpectedColumn("programs", families = setOf("long"), nullable = false),
                ExpectedColumn("avgPrice", families = setOf("decimal"), nullable = true),
                ExpectedColumn("cheapest", families = setOf("long"), nullable = true),
                ExpectedColumn("priciest", families = setOf("long"), nullable = true),
            ),
            report = "v_programs_over_time",
        ),
        "LiveIntroPrograms" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("status", families = setOf("varchar", "enumerationByName"), nullable = false),
                ExpectedColumn("programs", families = setOf("long"), nullable = false),
                ExpectedColumn("notDrafts", families = setOf("long"), nullable = false),
                ExpectedColumn("listValue", families = setOf("long"), nullable = true),
            ),
            report = "v_live_intro_programs",
        ),
        "ProgramsEmptyScope" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programs", families = setOf("long"), nullable = false),
                ExpectedColumn("avgPriceOrMinusOne", families = setOf("decimal"), nullable = false),
            ),
            report = "v_programs_empty_scope",
        ),
        "WeekShapes" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programTitle", families = setOf("varchar"), nullable = false),
                ExpectedColumn("weeks", families = setOf("long"), nullable = false),
                ExpectedColumn("unlabelled", families = setOf("long"), nullable = false),
                ExpectedColumn("labelledMinutes", families = setOf("long"), nullable = true),
                ExpectedColumn("shortWeeks", families = setOf("long"), nullable = false),
                ExpectedColumn("midWeeks", families = setOf("long"), nullable = false),
                ExpectedColumn("longWMinutes", families = setOf("long"), nullable = true),
            ),
            report = "v_week_shapes",
        ),
        "SessionsByProgram" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programTitle", families = setOf("varchar"), nullable = false),
                ExpectedColumn("weekKey", families = setOf("long"), nullable = true),
                ExpectedColumn("sessions", families = setOf("long"), nullable = false),
                ExpectedColumn("sessionMinutes", families = setOf("long"), nullable = true),
            ),
            report = "v_sessions_by_program",
        ),
        "ProgramSessions" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("programKey", families = setOf("long"), nullable = false),
                ExpectedColumn("programTitle", families = setOf("varchar"), nullable = false),
                ExpectedColumn("sessions", families = setOf("long"), nullable = false),
                ExpectedColumn("sessionMinutes", families = setOf("long"), nullable = true),
                ExpectedColumn("sessionMinutesOrZero", families = setOf("long"), nullable = false),
            ),
            report = "v_program_sessions",
        ),
        "NodesByParent" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("parentLabel", families = setOf("varchar"), nullable = true),
                ExpectedColumn("nodes", families = setOf("long"), nullable = false),
            ),
            report = "v_nodes_by_parent",
        ),
        "AuthsByKind" to EntityExpectation(
            columns = listOf(
                ExpectedColumn("kind", families = setOf("varchar", "enumerationByName"), nullable = true),
                ExpectedColumn("auths", families = setOf("long"), nullable = false),
                ExpectedColumn("distinctRefs", families = setOf("long"), nullable = false),
            ),
            report = "v_auths_by_kind",
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
                expected.report?.let { view -> assertSourceIsExactlyTheReportTable(entity, source, view, expected.columns) }
            }
        } finally {
            outDir.deleteRecursively()
        }
    }

    /**
     * The hand-written reference tables the persistence lane reads the views through hold the
     * same expectations: the view, the columns in order, and which are nullable. Without this
     * a reference table could drift from the generator and the lane would only notice when a
     * value happened to be null.
     */
    @Test
    fun `the hand-written report reference tables match the same expectations`() {
        // The SAME registry the persistence lane's `tableFor` consults — one name list, two
        // consumers, so the lanes cannot silently cover different report sets.
        val references = ReportViews.BY_NAME
        assertEquals(expectations.filterValues { it.report != null }.keys, references.keys)
        for ((report, table) in references) {
            val expected = expectations.getValue(report)
            assertEquals(expected.report, table.tableName, report)
            assertEquals(
                expected.columns.map { it.name to it.nullable },
                table.columns.map { it.name to it.columnType.nullable },
                "$report: the reference table's columns (name to nullable)",
            )
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
            // Nullability is asserted only where the expectation states it (the reports).
            col.nullable?.let { nullable ->
                val line = source.lineSequence().first { Regex("""\bval\s+${Regex.escape(col.name)}\s*=""").containsMatchIn(it) }
                assertTrue(
                    line.trimEnd().endsWith(".nullable()") == nullable,
                    "${entity}Table.kt: expected column '${col.name}' to be ${if (nullable) "nullable" else "non-null"}; saw `${line.trim()}`"
                )
            }
        }
    }

    /**
     * A report's table (FR-044) is held tighter than an entity's: it binds [view], declares
     * EXACTLY the expected columns in the expected order (the derived fields — dimensions,
     * then measures — and nothing else), and has no primary key, because a report has no
     * identity.
     */
    private fun assertSourceIsExactlyTheReportTable(
        entity: String,
        source: String,
        view: String,
        expected: List<ExpectedColumn>,
    ) {
        assertTrue(
            "object ${entity}Table : Table(\"$view\")" in source,
            "${entity}Table.kt: expected the table to bind the view '$view'; saw:\n$source",
        )
        val declared = Regex("""^\s*val\s+(\w+)\s*=""", RegexOption.MULTILINE).findAll(source).map { it.groupValues[1] }.toList()
        assertTrue(
            declared == expected.map { it.name },
            "${entity}Table.kt: expected exactly the columns ${expected.map { it.name }} in that order; saw $declared",
        )
        assertTrue("primaryKey" !in source, "${entity}Table.kt: a report has no identity, so no primaryKey; saw:\n$source")
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

    private data class ExpectedColumn(val name: String, val families: Set<String>, val nullable: Boolean? = null)
    private data class ExpectedFk(val columnName: String, val targetTable: String)
    private data class EntityExpectation(
        val columns: List<ExpectedColumn>,
        val foreignKeys: List<ExpectedFk> = emptyList(),
        /** For an `object.report` (FR-044): the view its table binds. Null for every other object. */
        val report: String? = null,
    )
}
