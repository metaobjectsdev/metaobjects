package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Tables mirroring `LedgerEntry` and `ArchivedLedgerEntry` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`: two tables named
 * `ledger_entries`, the second in the `archive` schema. Exposed takes the schema-qualified name
 * in the table-name argument, as `KotlinExposedTableGenerator` writes it for `@schema`.
 */
internal object LedgerEntryTable : Table("ledger_entries") {
    val id = long("id").autoIncrement()
    val memo = varchar("memo", 40).nullable()

    override val primaryKey = PrimaryKey(id)
}

internal object ArchivedLedgerEntryTable : Table("archive.ledger_entries") {
    val id = long("id").autoIncrement()
    val memo = varchar("memo", 40).nullable()

    override val primaryKey = PrimaryKey(id)
}
