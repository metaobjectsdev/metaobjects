package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * `programs` table matching the v2 metadata state at
 * `fixtures/persistence-conformance/migrations/states/program-v2/meta.json`
 * — v1 columns plus a new nullable `subtitle` column (VARCHAR(200)).
 *
 * Note this is a DIFFERENT Kotlin object from [ProgramV1Table] but maps to
 * the SAME physical table name (`programs`). The add-nullable-column scenario
 * exercises the Exposed-substrate analogue of an additive migration: bootstrap
 * via v1, then run `SchemaUtils.addMissingColumnsStatements(ProgramV2Table)`
 * to surface the ALTER TABLE ADD COLUMN statement.
 *
 * NOT [ProgramTable]: that object is the *canonical-current* shape with
 * priceCents/status/createdAt/etc., used for query scenarios. The migration
 * v1/v2 corpus uses a deliberately stripped-down Program (id + title) so the
 * additive-column diff is unambiguous.
 */
object ProgramV2Table : Table("programs") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 200)
    val subtitle = varchar("subtitle", 200).nullable()

    override val primaryKey = PrimaryKey(id)
}
