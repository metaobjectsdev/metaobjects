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
    // weekCount = COUNT(...) → BIGINT → string. (Always non-null: COUNT over zero rows is 0.)
    val weekCount = long("weekCount")
    // The four Phase B aggregate projections over Week.durationMinutes. All nullable — SQL
    // SUM/AVG/MIN/MAX over an empty group yield NULL (→ JSON null per normalization.md).
    // The wire shape is driven by the ACTUAL Postgres aggregate result type, so the Exposed
    // mapping mirrors that, NOT the field.* declaration:
    //   - SUM(int) → BIGINT  → Exposed `long`    → string  ("180")
    //   - AVG(int) → NUMERIC → Exposed `decimal` → string  ("60", no trailing zeros)
    //   - MIN(int) → INTEGER → Exposed `integer` → number  (30)
    //   - MAX(int) → INTEGER → Exposed `integer` → number  (90)
    // The decimal precision/scale below are immaterial: this is a read-only VIEW mapping (we
    // never call SchemaUtils.create), so they don't emit DDL — Exposed just reads the column
    // value back as a BigDecimal, which Normalization renders with the no-trailing-zeros rule.
    val totalMinutes = long("totalMinutes").nullable()
    val avgMinutes = decimal("avgMinutes", 38, 18).nullable()
    val minMinutes = integer("minMinutes").nullable()
    val maxMinutes = integer("maxMinutes").nullable()

    override val primaryKey = PrimaryKey(programId)
}
