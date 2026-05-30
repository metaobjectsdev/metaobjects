package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.CustomFunction
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.UUIDColumnType
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.json.jsonb

/**
 * Hand-written reference Exposed Table mirroring `Asset` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json` — the R6 Plan 2a/2b
 * native-physical-column subject. Byte-for-byte the shape that
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits for this entity:
 *
 *   - `field.uuid` PK + `@generation:uuid`           → `uuid("id")` + gen_random_uuid() DEFAULT
 *   - `field.uuid` (non-key, @required)              → `uuid("ownerId")` (Postgres native uuid)
 *   - `field.string` + `@dbColumnType:uuid`          → `uuid("externalId")` (native uuid column; generated DATA-CLASS property stays String)
 *   - `field.string` + `@dbColumnType:jsonb`         → `jsonb("payload", …)` (real Postgres JSONB)
 *   - `field.timestamp` + `@dbColumnType:timestamp_with_tz` → `timestampWithTimeZone("recordedAt")`
 *
 * The PK's server-side `gen_random_uuid()` DEFAULT lets a row be inserted with NO id
 * (Postgres mints it) — the generation proof in `asset-uuid-roundtrip.yaml`.
 *
 * Column names are verbatim (the corpus seed-SQL / expectations use camelCase quoted
 * identifiers), so this table does NOT snake_case — matching the fixture's literal columns.
 */
object AssetTable : Table("assets") {
    val id = uuid("id").defaultExpression(CustomFunction("gen_random_uuid", UUIDColumnType()))
    val ownerId = uuid("ownerId")
    // `@dbColumnType:uuid` on a field.string → native uuid column. Exposed surfaces this as
    // a java.util.UUID at the SQL boundary; the normalizer lowercases it canonically.
    val externalId = uuid("externalId")
    // `@dbColumnType:jsonb` open-JSON column. Identity encode/decode keeps the raw JSON text
    // (the property is String); the runner parses it to a Map before normalization so the
    // jsonb re-serializes with sorted keys per the normalization contract.
    val payload = jsonb("payload", { it }, { it })
    val recordedAt = timestampWithTimeZone("recordedAt")

    override val primaryKey = PrimaryKey(id)
}
