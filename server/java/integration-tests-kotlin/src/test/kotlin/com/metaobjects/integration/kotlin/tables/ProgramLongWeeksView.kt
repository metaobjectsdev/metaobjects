package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramLongWeeks` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_long_weeks`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * The report declares `@spine: "Week.fkProgram"` and `@segment: long`. The segment sits in
 * the LEFT OUTER JOIN's ON clause, so a program with no long week keeps its row. No column
 * is nullable (`fixtures/persistence-conformance/report-shapes.json` says `required: true`
 * for all three):
 *   - `programKey`         = Program.id, the spine entity's key → BIGINT → `long`
 *   - `weeks`              = a count, 0 on the empty row        → BIGINT → `long`
 *   - `totalMinutesOrZero` = a sum with `@default: 0`           → BIGINT → `long`
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramLongWeeksView : Table("v_program_long_weeks") {
    val programKey = long("programKey")
    val weeks = long("weeks")
    val totalMinutesOrZero = long("totalMinutesOrZero")
}
