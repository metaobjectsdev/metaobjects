package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date

/**
 * Hand-written reference Exposed Table mapping the `AllTypesBreakdown` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_all_types_breakdown`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types; an int-backed enum dimension carries the member SYMBOL, as
 * [AllTypesTable] does for the base column.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object AllTypesBreakdownView : Table("v_all_types_breakdown") {
    val flag = bool("flag")
    val level = varchar("level", 64)
    val legacyStatus = intBackedEnum("legacyStatus", INT_ENUM_MEMBERS).nullable()
    val dateKey = date("dateKey")
    val uuidKey = uuid("uuidKey")
    val allRows = long("allRows")
    val totalInts = long("totalInts").nullable()
    val avgDec = decimal("avgDec", 38, 18).nullable()
    val maxMoney = long("maxMoney").nullable()
    val minLong = long("minLong").nullable()
    val highRows = long("highRows")
}
