package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `ProgramStat` projection
 * from `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Backed by the Postgres VIEW `v_program_stat` (NOT a base table) — see
 * [VIEW_DDL] for the correlated-subquery aggregate body the
 * [com.metaobjects.integration.kotlin.QueryScenarioRunner] issues alongside
 * `SchemaUtils.create(...)` for scenarios touching this projection.
 *
 * Exposed has no first-class "view" Table — using `Table("v_program_stat")`
 * is the conventional Exposed pattern for read-only SELECTs over a view:
 * `selectAll()` issues `SELECT * FROM v_program_stat`, exactly what the
 * projection-aggregate scenario expects. We never call `SchemaUtils.create`
 * on this object — the view is created via raw SQL.
 */
object ProgramStatView : Table("v_program_stat") {
    val programId = long("programId")
    val weekCount = long("weekCount")

    override val primaryKey = PrimaryKey(programId)

    /**
     * Correlated-subquery aggregate body, matching the metadata's
     * `origin.aggregate{@agg: count, @of: Week.id, @via: Program.weeks}`
     * shape and the canonical view-DDL pattern documented in
     * `docs/superpowers/specs/2026-05-22-fr-003-*` for cross-language ports.
     *
     * Identifier quoting matches the seed DDL: bare lowercase for table
     * names, double-quoted camelCase for column names — same convention
     * `SchemaUtils.create(ProgramTable, WeekTable)` produces.
     */
    const val VIEW_DDL =
        """CREATE OR REPLACE VIEW "v_program_stat" AS
           SELECT p."id" AS "programId",
                  (SELECT COUNT(w."id") FROM "weeks" w WHERE w."programId" = p."id") AS "weekCount"
             FROM "programs" p"""
}
