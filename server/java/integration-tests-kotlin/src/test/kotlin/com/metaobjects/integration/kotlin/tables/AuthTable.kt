package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table for the FR-017 Table-Per-Hierarchy (TPH) `auths` table
 * from `fixtures/persistence-conformance/canonical/meta.fitness.json` — the SINGLE physical table
 * shared by the `Auth` discriminator base and its `BridgeAuth` / `CopayAuth` / `PriorAuthAuth`
 * subtypes (single-table inheritance).
 *
 * Every subtype-only column is NULLABLE — a row of any other subtype stores NULL there, even
 * when the field is `@required` on its subtype. The `QueryScenarioRunner` addresses this one
 * table for every TPH entity (base + subtypes), injecting the discriminator (`type`) on create
 * and scoping each read/update/delete to the subtype's discriminator value.
 *
 * Column shapes follow the canonical DDL's `auths` table:
 *  - `id`          BIGINT GENERATED … AS IDENTITY  → `long("id").autoIncrement()` (PK)
 *  - `type`        TEXT (discriminator, CHECK in DDL) → `varchar("type", 64)`
 *  - `reference`   VARCHAR(80) NOT NULL            → `varchar("reference", 80)`
 *  - `quantity`    INTEGER (BridgeAuth-only)       → `integer("quantity").nullable()`
 *  - `copayAmount` NUMERIC(10,2) (CopayAuth-only)  → `decimal("copayAmount", 10, 2).nullable()`
 *  - `approver`    VARCHAR(80) (PriorAuthAuth-only) → `varchar("approver", 80).nullable()`
 */
object AuthTable : Table("auths") {
    val id = long("id").autoIncrement()
    val type = varchar("type", 64)
    val reference = varchar("reference", 80)
    val quantity = integer("quantity").nullable()
    val copayAmount = decimal("copayAmount", 10, 2).nullable()
    val approver = varchar("approver", 80).nullable()

    override val primaryKey = PrimaryKey(id)
}
