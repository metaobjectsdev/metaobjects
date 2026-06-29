package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.CustomFunction
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.UUIDColumnType
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.datetime
import org.jetbrains.exposed.sql.json.jsonb
import kotlinx.serialization.json.Json

/**
 * Hand-written reference Exposed Table mirroring `Asset` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json` — the R6 Plan 2a/2b
 * native-physical-column subject. Byte-for-byte the shape that
 * [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator] emits for this entity:
 *
 *   - `field.uuid` PK + `@generation:uuid`           → `uuid("id")` + gen_random_uuid() DEFAULT
 *   - `field.uuid` (non-key, @required)              → `uuid("ownerId")` (Postgres native uuid)
 *   - `field.string` + `@dbColumnType:uuid`          → `uuid("externalId")` (native uuid column; generated DATA-CLASS property stays String)
 *   - `field.string` + `@dbColumnType:jsonb`         → `jsonb("payload", …)` (real Postgres JSONB; parsed to kotlinx JsonElement, issue #98)
 *   - `field.timestamp` + `@dbColumnType:timestamp_with_tz` → `instantWithTimeZone("recordedAt")`
 *     (a `Column<java.time.Instant>` whose DDL is `TIMESTAMP WITH TIME ZONE` — matches the
 *     `Instant` data-class property with zero coercion; see [instantWithTimeZone])
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
    // `@dbColumnType:jsonb` open-JSON column (#98). The codec PARSES the JSONB text to a kotlinx
    // `JsonElement` (decode `Json.parseToJsonElement`, encode `it.toString()`), so the column is
    // `Column<JsonElement>` and a read returns a parsed JSON value (uniform with the generated
    // entity data-class property + REST payload). The runner converts the JsonElement to a Map
    // before normalization so the jsonb re-serializes with sorted keys per the normalization
    // contract. Byte-for-byte the codec KotlinExposedTableGenerator now emits for this column.
    val payload = jsonb("payload", { it.toString() }, { Json.parseToJsonElement(it) })
    // `recordedAt` is a TIMESTAMPTZ column surfaced as java.time.Instant (the metaobjects
    // `instantWithTimeZone` Column<Instant> path — matches the `Instant` data class with no
    // OffsetDateTime coercion). The instant is already UTC, so Normalization renders it at
    // UTC and emits the `…Z` suffix (the TZ discriminator) — distinguishing it from the plain
    // TIMESTAMP `observedAt` below (which has no Z). See InstantWithTimeZoneColumnType.
    val recordedAt = instantWithTimeZone("recordedAt")
    // The three @required temporal columns added in Phase B (full wire-type coverage).
    //  - `observedAt`: plain TIMESTAMP (no tz) → java.time.LocalDateTime → "YYYY-MM-DDTHH:MM:SS" (no Z).
    //  - `asOfDate`:   DATE                    → java.time.LocalDate     → "YYYY-MM-DD".
    //  - `atTime`:     TIME                    → java.time.LocalTime     → "HH:MM:SS[.fff]".
    val observedAt = datetime("observedAt")
    val asOfDate = date("asOfDate")
    // `preciseTime` (not Exposed's stock `time`) — the stock TIME column type reads via
    // java.sql.Time and truncates sub-second precision, which would drop the SP-A
    // millisecond fractional component. See PreciseLocalTimeColumnType.
    val atTime = preciseTime("atTime")

    override val primaryKey = PrimaryKey(id)
}
