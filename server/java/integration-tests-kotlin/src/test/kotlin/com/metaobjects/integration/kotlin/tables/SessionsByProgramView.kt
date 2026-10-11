package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `SessionsByProgram` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_sessions_by_program`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object SessionsByProgramView : Table("v_sessions_by_program") {
    val programTitle = varchar("programTitle", 200).nullable()
    val weekKey = long("weekKey").nullable()
    val sessions = long("sessions")
    val sessionMinutes = long("sessionMinutes").nullable()
}
