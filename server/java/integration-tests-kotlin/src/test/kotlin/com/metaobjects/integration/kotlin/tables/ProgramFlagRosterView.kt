package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramFlagRoster` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_flag_roster`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * The report declares `@spine: "Week.fkProgram"`, so a program with no week still has a row,
 * on which a boolean aggregate with no `@default` is NULL and one with `@default: 0` / `1`
 * reads false / true (`fixtures/persistence-conformance/report-shapes.json`):
 *   - `programKey`        = Program.id, the spine entity's key   → BIGINT  → `long`
 *   - `weeks`             = a count, 0 on the empty row          → BIGINT  → `long`
 *   - `anyDeload`         = `any`, no `@default`                 → BOOLEAN → `bool`, nullable
 *   - `anyDeloadOrFalse`  = `any`, `@default: 0`                 → BOOLEAN → `bool`
 *   - `allDeloadOrTrue`   = `all`, `@default: 1`                 → BOOLEAN → `bool`
 *
 * A report has no identity, so there is no `primaryKey`.
 */
object ProgramFlagRosterView : Table("v_program_flag_roster") {
    val programKey = long("programKey")
    val weeks = long("weeks")
    val anyDeload = bool("anyDeload").nullable()
    val anyDeloadOrFalse = bool("anyDeloadOrFalse")
    val allDeloadOrTrue = bool("allDeloadOrTrue")
}
