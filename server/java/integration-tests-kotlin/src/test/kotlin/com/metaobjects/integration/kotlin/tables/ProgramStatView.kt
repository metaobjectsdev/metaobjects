package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramStat` projection
 * from `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_stat` (NOT a base table). The view is
 * created by the committed canonical DDL
 * (`fixtures/persistence-conformance/canonical/schema.postgres.sql`); this
 * object is purely the read-only query mapping.
 *
 * Exposed has no first-class "view" Table — using `Table("v_program_stat")`
 * is the conventional Exposed pattern for read-only SELECTs over a view:
 * `selectAll()` issues `SELECT * FROM v_program_stat`, exactly what the
 * projection-aggregate scenario expects. We never call `SchemaUtils.create`
 * on this object — the view is part of the committed schema DDL.
 *
 * Column names are the canonical DDL's literal physical columns (`programId`,
 * `weekCount`) so the query dispatcher addresses the view's actual columns.
 */
object ProgramStatView : Table("v_program_stat") {
    val programId = long("programId")
    val weekCount = long("weekCount")

    override val primaryKey = PrimaryKey(programId)
}
