package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `EntryTotals` report (ADR-0019 Amendment 1)
 * from `fixtures/persistence-conformance/canonical/meta.fitness.json`, backed by the view
 * `v_entry_totals`. Every decimal measure (a sum, an average, a maximum, a ratio) is an exact
 * decimal on Postgres and MySQL and a double on SQLite, read at 15 significant digits. A count is
 * a `long`. Nullability follows `report-shapes.json`.
 */
internal object EntryTotalsView : Table("v_entry_totals") {
    val bucket = varchar("bucket", 8)
    val entries = long("entries")
    val total = portableDecimal("total", 38, 18).nullable()
    val totalOrZero = portableDecimal("totalOrZero", 38, 18)
    val mean = portableDecimal("mean", 38, 18).nullable()
    val top = portableDecimal("top", 38, 18).nullable()
    val flaggedShare = portableDecimal("flaggedShare", 38, 18).nullable()
    val perFlagged = portableDecimal("perFlagged", 38, 18).nullable()
}
