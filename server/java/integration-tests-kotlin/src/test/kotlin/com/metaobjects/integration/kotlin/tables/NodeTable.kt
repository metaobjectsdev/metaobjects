package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Node` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Self-referential NULLABLE FK: `parentId` references [id] on this SAME table,
 * declared via `identity.reference fkParent → Node` on the canonical metadata.
 * `id` is declared BEFORE `parentId` so the self-reference resolves during the
 * object's top-to-bottom initialization (the same PK-first ordering the
 * KotlinExposedTableGenerator emits for a generated self-FK table).
 */
object NodeTable : Table("nodes") {
    val id = long("id").autoIncrement()
    val label = varchar("label", 80)
    val parentId = long("parentId").references(id).nullable()

    override val primaryKey = PrimaryKey(id)
}
