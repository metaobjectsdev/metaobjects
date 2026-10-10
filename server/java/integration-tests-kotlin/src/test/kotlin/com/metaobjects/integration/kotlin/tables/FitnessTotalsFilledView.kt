package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `FitnessTotalsFilled` report (FR-044)
 * from `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_fitness_totals_filled`, created by the committed canonical
 * DDL (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is
 * purely the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * [FitnessTotalsView] with `@default: 0` on its sum and its ratio. No dimensions, so the view
 * returns exactly one row, over an empty table too, and then every column is 0, never NULL.
 * No column is nullable (`fixtures/persistence-conformance/report-shapes.json` says
 * `required: true` for all three):
 *   - `weeks`              = a count                     → BIGINT  → `long`
 *   - `totalMinutesOrZero` = a sum with `@default: 0`    → BIGINT  → `long`
 *   - `longShareOrZero`    = a ratio with `@default: 0`  → NUMERIC → `decimal`
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object FitnessTotalsFilledView : Table("v_fitness_totals_filled") {
    val weeks = long("weeks")
    val totalMinutesOrZero = long("totalMinutesOrZero")
    val longShareOrZero = decimal("longShareOrZero", 38, 18)
}
