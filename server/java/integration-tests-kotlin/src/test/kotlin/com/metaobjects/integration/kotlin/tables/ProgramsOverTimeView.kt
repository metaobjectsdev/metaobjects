package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date

/**
 * Hand-written reference Exposed Table mapping the `ProgramsOverTime` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_programs_over_time`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramsOverTimeView : Table("v_programs_over_time") {
    val createdAtDay = date("createdAtDay")
    val createdAtQuarter = date("createdAtQuarter")
    val createdAtYear = date("createdAtYear")
    val programs = long("programs")
    val avgPrice = portableDecimal("avgPrice", 38, 18).nullable()
    val cheapest = long("cheapest").nullable()
    val priciest = long("priciest").nullable()
}
