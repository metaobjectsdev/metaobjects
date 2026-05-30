package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Measurement` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 *  - `field.float`  → `float`  (REAL / float4, single precision)
 *  - `field.double` → `double` (DOUBLE PRECISION / float8)
 *
 * The two floating columns are the R6 float-fidelity round-trip subject.
 */
object MeasurementTable : Table("measurements") {
    val id = long("id").autoIncrement()
    val tempC = float("tempC")
    val massKg = double("massKg")

    override val primaryKey = PrimaryKey(id)
}
