package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date

/**
 * Hand-written reference Exposed Table mapping the `ProgramsByWeek` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_programs_by_week`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 *   - `createdAtWeek` = the ISO week bucket of Program.createdAt → DATE (the Monday that
 *     starts the week) → `date`
 *   - `programs`      = a count → BIGINT → `long`
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramsByWeekView : Table("v_programs_by_week") {
    val createdAtWeek = date("createdAtWeek")
    val programs = long("programs")
}
