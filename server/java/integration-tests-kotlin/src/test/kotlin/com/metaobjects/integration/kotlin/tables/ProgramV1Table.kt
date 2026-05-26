package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Minimal `programs` table matching the v1 metadata state at
 * `fixtures/persistence-conformance/migrations/states/program-v1/meta.json`
 * — `id` (BIGSERIAL PK) + `title` (NOT NULL VARCHAR(200)).
 *
 * Used by [com.metaobjects.integration.kotlin.MigrationScenarioConformanceTest]
 * to bootstrap the starting schema for additive-migration scenarios. The v2
 * counterpart is [ProgramV2Table]; running `addMissingColumnsStatements` with
 * v2 against a database created from v1 should emit `ALTER TABLE ... ADD COLUMN`
 * for the new column.
 */
object ProgramV1Table : Table("programs") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 200)

    override val primaryKey = PrimaryKey(id)
}
