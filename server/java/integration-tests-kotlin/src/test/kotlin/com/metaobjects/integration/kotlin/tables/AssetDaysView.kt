package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.datetime

/**
 * Hand-written reference Exposed Table mapping the `AssetDays` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_asset_days`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object AssetDaysView : Table("v_asset_days") {
    val recordedAtDay = date("recordedAtDay")
    val asOfDateMonth = date("asOfDateMonth")
    val assets = long("assets")
    val owners = long("owners")
    val firstRecorded = instantWithTimeZone("firstRecorded").nullable()
    val lastObserved = datetime("lastObserved").nullable()
    val lastAsOf = date("lastAsOf").nullable()
}
