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

    override val primaryKey = PrimaryKey(id)
}
