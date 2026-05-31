package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Week` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * The `programId` foreign key references [ProgramTable.id]; declared via
 * `identity.reference` on the canonical metadata.
 */
object WeekTable : Table("weeks") {
    val id = long("id").autoIncrement()
    val programId = long("programId").references(ProgramTable.id)
    val label = varchar("label", 80).nullable()
    // `field.int` → INTEGER (NOT NULL). Rolled up per Program by the v_program_stat
    // sum/avg/min/max aggregate projections (see ProgramStatView).
    val durationMinutes = integer("durationMinutes")

    override val primaryKey = PrimaryKey(id)
}
