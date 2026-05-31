package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramView` passthrough
 * projection from `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program` (NOT a base table) — a pure
 * passthrough of `id`/`title`/`status` from Program. The view is created by the
 * committed canonical DDL (`fixtures/persistence-conformance/canonical/schema.postgres.sql`);
 * this object is purely the read-only query mapping (the runtime passthrough-read
 * path the projection-passthrough scenario exercises).
 *
 * As with [ProgramStatView], Exposed has no first-class "view" Table — using
 * `Table("v_program")` is the conventional read-only-SELECT pattern. We never
 * call `SchemaUtils.create` on this object.
 *
 * Column names are the canonical DDL's literal physical columns (`id`, `title`,
 * `status`) so the query dispatcher addresses the view's actual columns.
 * `id` is field.long → BIGINT → string per normalization.md.
 */
object ProgramView : Table("v_program") {
    val id = long("id")
    val title = varchar("title", 200)
    val status = varchar("status", 64)

    override val primaryKey = PrimaryKey(id)
}
