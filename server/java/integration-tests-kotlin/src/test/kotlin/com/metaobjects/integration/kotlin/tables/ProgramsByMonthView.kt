package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date

/**
 * Hand-written reference Exposed Table mapping the `ProgramsByMonth` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_programs_by_month`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 *   - `createdAtMonth` = the month bucket of Program.createdAt → DATE (the first day of the
 *     month) → `date`
 *   - `status`         = Program.status, an enum → VARCHAR; read as its member symbol, the
 *     way [ProgramTable] reads the base column
 *   - `programs`       = a count → BIGINT → `long`
 *   - `listValue`      = a filtered sum of a currency → BIGINT minor units → `long`, nullable
 *     (NULL when no row in the group matches the measure's filter)
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramsByMonthView : Table("v_programs_by_month") {
    val createdAtMonth = date("createdAtMonth")
    val status = varchar("status", 64)
    val programs = long("programs")
    val listValue = long("listValue").nullable()
}
