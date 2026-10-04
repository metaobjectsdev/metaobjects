package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramMinutes` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_minutes`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * One column per derived field (dimensions, then measures), each mirroring the view's REAL
 * column type and nullable exactly where `fixtures/persistence-conformance/report-shapes.json`
 * says `required: false`:
 *   - `program`      = Week.programId (required FK)    → BIGINT  → `long`
 *   - `programTitle` = Program.title, reached by @via  → VARCHAR → `varchar`, nullable
 *   - a `count`, with or without @distinct             → BIGINT  → `long` (never null)
 *   - `sum` of an int, cast by the view                → BIGINT  → `long`, nullable
 *   - `avg`, and a ratio                               → NUMERIC → `decimal`, nullable
 *   - `min` / `max` of an int                          → INTEGER → `integer`, nullable
 * The decimal precision and scale never reach DDL (this maps a view); they are the scale
 * Exposed reads the unconstrained NUMERIC back at.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object ProgramMinutesView : Table("v_program_minutes") {
    val program = long("program")
    val programTitle = varchar("programTitle", 200).nullable()
    val weeks = long("weeks")
    val longWeeks = long("longWeeks")
    val labels = long("labels")
    val slots = long("slots")
    val totalMinutes = long("totalMinutes").nullable()
    val avgMinutes = decimal("avgMinutes", 38, 18).nullable()
    val minMinutes = integer("minMinutes").nullable()
    val maxMinutes = integer("maxMinutes").nullable()
    val longShare = decimal("longShare", 38, 18).nullable()
}
