package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mirroring `Entry` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`: the decimal subject of the
 * `decimal-exact` scenarios (ADR-0019 Amendment 1). `amount` is `decimal(28,10)` and nullable;
 * its column type is the reference twin of the generated portable decimal, so SQLite reads a
 * double at 15 significant digits.
 */
internal object EntryTable : Table("entries") {
    val id = long("id").autoIncrement()
    val bucket = varchar("bucket", 8)
    val amount = portableDecimal("amount", 28, 10).nullable()
    val flagged = bool("flagged")

    override val primaryKey = PrimaryKey(id)
}
