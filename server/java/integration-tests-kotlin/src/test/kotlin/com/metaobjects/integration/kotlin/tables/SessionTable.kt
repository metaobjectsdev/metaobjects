package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Session` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`: the fact table the
 * multi-hop report scenarios (`SessionsByProgram`, `ProgramSessions`) read through the
 * `fkWeek` reference and, from the week, `fkProgram`. It is only seeded here; the reports are
 * read through their views.
 */
object SessionTable : Table("sessions") {
    val id = long("id").autoIncrement()
    val weekId = long("weekId").references(WeekTable.id)
    val minutes = integer("minutes")

    override val primaryKey = PrimaryKey(id)
}
