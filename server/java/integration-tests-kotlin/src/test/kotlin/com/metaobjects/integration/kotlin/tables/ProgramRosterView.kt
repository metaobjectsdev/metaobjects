package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramRoster` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_roster`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * The report declares `@spine: "Week.fkProgram"`, so the view starts from `programs` and
 * LEFT OUTER JOINs `weeks`: a program with no week still has a row. Nullable exactly where
 * `fixtures/persistence-conformance/report-shapes.json` says `required: false`:
 *   - `programKey`         = Program.id, the spine entity's key       → BIGINT  → `long`
 *   - `programTitle`       = Program.title, a `@required` column of
 *                            the spine entity                         → VARCHAR → `varchar`
 *   - `weeks`              = a count, 0 on the empty row              → BIGINT  → `long`
 *   - `totalMinutes`       = a sum, NULL on the empty row             → BIGINT  → `long`, nullable
 *   - `totalMinutesOrZero` = the same sum with `@default: 0`          → BIGINT  → `long`
 *   - `longShare`          = a ratio, NULL on the empty row           → NUMERIC → `decimal`, nullable
 *   - `longShareOrZero`    = the same ratio with `@default: 0`        → NUMERIC → `decimal`
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramRosterView : Table("v_program_roster") {
    val programKey = long("programKey")
    val programTitle = varchar("programTitle", 200)
    val weeks = long("weeks")
    val totalMinutes = long("totalMinutes").nullable()
    val totalMinutesOrZero = long("totalMinutesOrZero")
    val longShare = decimal("longShare", 38, 18).nullable()
    val longShareOrZero = decimal("longShareOrZero", 38, 18)
}
