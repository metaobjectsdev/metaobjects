package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `LiveIntroPrograms` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_live_intro_programs`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object LiveIntroProgramsView : Table("v_live_intro_programs") {
    val status = varchar("status", 64)
    val programs = long("programs")
    val notDrafts = long("notDrafts")
    val listValue = long("listValue").nullable()
}
