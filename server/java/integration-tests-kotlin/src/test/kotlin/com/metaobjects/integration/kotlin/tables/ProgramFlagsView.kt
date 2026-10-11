package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramFlags` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_flags`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * The boolean measures are `@agg: any` / `all` over the nullable `Week.deload`: Postgres
 * `bool_or` / `bool_and`, a BOOLEAN that is NULL for a group with no value to judge. None
 * declares a `@default`, so none is required (`fixtures/persistence-conformance/report-shapes.json`):
 *   - `program`       = Week.programId, a dimension          → BIGINT  → `long`
 *   - `weeks`         = a count                              → BIGINT  → `long`
 *   - `anyDeload`     = `any`                                → BOOLEAN → `bool`, nullable
 *   - `allDeload`     = `all`                                → BOOLEAN → `bool`, nullable
 *   - `anyLongDeload` = `any` scoped by the `long` segment   → BOOLEAN → `bool`, nullable
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramFlagsView : Table("v_program_flags") {
    val program = long("program")
    val weeks = long("weeks")
    val anyDeload = bool("anyDeload").nullable()
    val allDeload = bool("allDeload").nullable()
    val anyLongDeload = bool("anyLongDeload").nullable()
}
