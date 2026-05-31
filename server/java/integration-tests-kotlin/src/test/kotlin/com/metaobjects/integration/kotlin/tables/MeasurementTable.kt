package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Measurement` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 *  - `field.float`   → `float`   (REAL / float4, single precision)
 *  - `field.double`  → `double`  (DOUBLE PRECISION / float8)
 *  - `field.decimal` → `decimal` (NUMERIC(9,4), exact precision — SP-A)
 *
 * The two floating columns are the R6 float-fidelity round-trip subject; `preciseKg` is
 * the SP-A field.decimal exact-precision subject (NUMERIC round-trips as a canonical
 * no-trailing-zeros string). Column names are verbatim camelCase (the corpus seed-SQL /
 * expectations use quoted camelCase identifiers), so this table does NOT snake_case.
 */
object MeasurementTable : Table("measurements") {
    val id = long("id").autoIncrement()
    val tempC = float("tempC")
    val massKg = double("massKg")
    val preciseKg = decimal("preciseKg", 9, 4)

    override val primaryKey = PrimaryKey(id)
}
