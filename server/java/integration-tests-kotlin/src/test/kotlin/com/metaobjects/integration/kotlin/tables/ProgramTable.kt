package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.datetime

/**
 * Hand-written reference Exposed Table mirroring `Program` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`.
 *
 * Doubles as (a) the persistence target the query/migration scenarios
 * execute against and (b) the structural reference the codegen-matches
 * test compares the generator's emitted source against. Field order +
 * column types match `KotlinExposedTableGenerator`'s mapping for the
 * canonical metadata exactly.
 *
 * Notable mappings:
 *  - `field.long`     → `long`         (BIGINT)
 *  - `field.string`   → `varchar`      (with explicit `@maxLength`)
 *  - `field.currency` → `long`         (BIGINT minor units; per cross-language wire contract)
 *  - `field.enum`     → `varchar(64)`  (string-backed enum; matches ENUM_VARCHAR_LEN)
 *  - `field.timestamp`→ `timestamp`    (no TZ; matches the corpus seed-data shape)
 *
 * Note: the generator emits `timestampWithTimeZone` today; for these
 * integration tests we use `timestamp` to align with the corpus's
 * `'2026-05-01T10:00:00'` literals (no TZ suffix). The codegen-matches
 * test compares structure (column names + base type families), not the
 * timestamp-tz variant — see `KotlinCodegenMatchesReferenceTest`.
 */
object ProgramTable : Table("programs") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 200)
    val priceCents = long("priceCents")
    val status = varchar("status", 64)
    // `datetime` → Postgres TIMESTAMP (no TZ), returned as java.time.LocalDateTime;
    // matches the wall-clock literal shape (`'2026-05-01T10:00:00'`) used in the
    // corpus seed-data + normalization contract (`yyyy-MM-ddTHH:mm:ss`, no zone).
    // `created_ts` comes from the field's explicit `@column`, and is deliberately NOT
    // the snake_case of `createdAt` — that coincidence is what let the generator ignore
    // `@column` entirely without any corpus noticing.
    val createdAt = datetime("created_ts")

    override val primaryKey = PrimaryKey(id)
}
