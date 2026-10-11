package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `AuthsByKind` report (FR-044) from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_auths_by_kind`, created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this object is purely
 * the read-only query mapping, as [ProgramStatView] is for a projection. Column types and
 * nullability follow `fixtures/persistence-conformance/report-shapes.json` and the view's
 * physical column types.
 *
 * A report has no identity, so there is no `primaryKey`: it is listed and counted, never
 * fetched by id. Column names are the derived field names (the corpus's `literal` naming).
 */
object AuthsByKindView : Table("v_auths_by_kind") {
    val kind = varchar("kind", 64).nullable()
    val auths = long("auths")
    val distinctRefs = long("distinctRefs")
}
