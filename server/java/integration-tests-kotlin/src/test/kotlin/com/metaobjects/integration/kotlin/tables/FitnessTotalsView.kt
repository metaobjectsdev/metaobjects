package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `FitnessTotals` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_fitness_totals`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 * No dimensions, so the view returns exactly one row, over an empty table too: `weeks`
 * (a count, BIGINT) is then `0`, and `totalMinutes` (a sum, BIGINT) and `longShare` (a ratio,
 * NUMERIC) are NULL — hence nullable.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object FitnessTotalsView : Table("v_fitness_totals") {
    val weeks = long("weeks")
    val totalMinutes = long("totalMinutes").nullable()
    val longShare = decimal("longShare", 38, 18).nullable()
}
