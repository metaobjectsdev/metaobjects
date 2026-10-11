package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `MeasurementStats` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_measurement_stats`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object MeasurementStatsView : Table("v_measurement_stats") {
    val readings = long("readings")
    val totalMassKg = double("totalMassKg").nullable()
    val avgMassKg = double("avgMassKg").nullable()
    val maxTempC = float("maxTempC").nullable()
    val minTempC = float("minTempC").nullable()
    val totalPreciseKg = decimal("totalPreciseKg", 38, 18).nullable()
    val avgPreciseKg = decimal("avgPreciseKg", 38, 18).nullable()
    val maxPreciseKg = decimal("maxPreciseKg", 38, 18).nullable()
    val heavyReadings = long("heavyReadings")
}
