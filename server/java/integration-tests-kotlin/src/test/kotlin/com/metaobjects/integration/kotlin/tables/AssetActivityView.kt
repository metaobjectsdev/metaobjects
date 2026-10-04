package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.date

/**
 * Hand-written reference Exposed Table mapping the `AssetActivity` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_asset_activity`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection.
 *
 *   - `recordedAtHour` = the hour bucket of Asset.recordedAt, an instant → TIMESTAMPTZ →
 *     [instantWithTimeZone], the same `Column<java.time.Instant>` [AssetTable] reads the base
 *     column with (so it normalizes to the `…Z` wire form)
 *   - `asOfDateWeek`   = the ISO week bucket of Asset.asOfDate, a date → DATE → `date`
 *   - `assets`         = a count → BIGINT → `long`
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object AssetActivityView : Table("v_asset_activity") {
    val recordedAtHour = instantWithTimeZone("recordedAtHour")
    val asOfDateWeek = date("asOfDateWeek")
    val assets = long("assets")
}
