package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.CustomFunction
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.UUIDColumnType
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.datetime
import org.jetbrains.exposed.sql.json.jsonb

/**
 * Hand-written reference Exposed Table mirroring `AllTypes` from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json` — the SP-H WRITE
 * round-trip keystone. Every persistable field subtype in one table, so the
 * `op: roundtrip` scenario exercises the WRITE codec for each subtype against a real
 * Postgres column. Byte-for-byte the shape [com.metaobjects.generator.kotlin.KotlinExposedTableGenerator]
 * emits for this entity (the canonical DDL drives the physical column types):
 *
 *   - `field.uuid` PK + `@generation:uuid`              → `uuid("id")` + gen_random_uuid() DEFAULT
 *   - `field.string` (@maxLength 200)                   → `varchar("sVal", 200)`
 *   - `field.int`                                       → `integer("iVal")`
 *   - `field.long`                                      → `long("lVal")` (BIGINT)
 *   - `field.double`                                    → `double("dVal")` (DOUBLE PRECISION)
 *   - `field.float`                                     → `float("fVal")` (REAL)
 *   - `field.decimal` (@precision 18, @scale 6)         → `decimal("decVal", 18, 6)` (NUMERIC(18,6))
 *   - `field.boolean`                                   → `bool("bVal")`
 *   - `field.date`                                      → `date("dateVal")`
 *   - `field.time`                                      → `preciseTime("timeVal")` (millisecond-preserving TIME)
 *   - `field.timestamp`                                 → `datetime("tsVal")` (plain TIMESTAMP, no tz)
 *   - default `field.timestamp` (instant/TZ-aware, ADR-0036 Wave 2) → `instantWithTimeZone("tsTzVal")` (TIMESTAMPTZ)
 *   - `field.currency` (@currency USD)                  → `long("moneyVal")` (BIGINT minor units)
 *   - `field.enum` (@values LOW/MEDIUM/HIGH)            → `varchar("enumVal", 64)` (text + CHECK in DDL)
 *   - `field.uuid` (non-key, @required)                 → `uuid("uuidVal")` (Postgres native uuid)
 *   - `field.object` (@objectRef Settings, @storage jsonb) → `jsonb("settings", …)` (real Postgres JSONB)
 *
 * The PK's server-side `gen_random_uuid()` DEFAULT lets a row be inserted with NO id
 * (Postgres mints it) — the server-generated-PK proof in `roundtrip-all-types.yaml`.
 *
 * `timeVal` uses [preciseTime] (not Exposed's stock `time`) so the millisecond fractional
 * component survives the read (the stock TIME column reads through `java.sql.Time`, which
 * truncates sub-seconds). `settings` uses the raw-JSON-String `jsonb` path (identity
 * encode/decode) — the runner serializes the authoring map to JSON on write and parses the
 * read-back JSON to a Map for the sorted-key normalization.
 *
 * Column names are verbatim camelCase (the corpus expectations use quoted camelCase
 * identifiers + the canonical DDL uses literal camelCase columns), so this table does NOT
 * snake_case.
 */
object AllTypesTable : Table("all_types") {
    val id = uuid("id").defaultExpression(CustomFunction("gen_random_uuid", UUIDColumnType()))
    val sVal = varchar("sVal", 200)
    val iVal = integer("iVal")
    val lVal = long("lVal")
    val dVal = double("dVal")
    val fVal = float("fVal")
    val decVal = decimal("decVal", 18, 6)
    val bVal = bool("bVal")
    val dateVal = date("dateVal")
    // Millisecond-preserving TIME (see PreciseLocalTimeColumnType) — stock `time` truncates sub-seconds.
    val timeVal = preciseTime("timeVal")
    // Plain TIMESTAMP (no tz) → java.time.LocalDateTime → "YYYY-MM-DDTHH:MM:SS" (no Z).
    val tsVal = datetime("tsVal")
    // TIMESTAMPTZ → java.time.Instant (the instantWithTimeZone Column<Instant> path) → "…Z".
    val tsTzVal = instantWithTimeZone("tsTzVal")
    val moneyVal = long("moneyVal")
    val enumVal = varchar("enumVal", 64)
    val uuidVal = uuid("uuidVal")
    // `field.uri` → plain `text` column carrying the verbatim URI string (Postgres has no uri
    // type). See [MetaUriColumnType] — round-trips the URI unchanged.
    val uriVal = uriColumn("uriVal")
    // `field.inet` (IPv4 + IPv6) → Postgres-native `inet` columns. [MetaInetStringColumnType]
    // reads the driver's native inet wire string (bare host, NO `::text` cast → no /32|/128 mask;
    // canonical COMPRESSED IPv6) and binds the bare address on write.
    val inetVal = inetColumn("inetVal")
    val inet6Val = inetColumn("inet6Val")
    // `@storage:jsonb` typed owned-object column. Raw-JSON-String identity encode/decode keeps
    // the JSON text; the runner serializes the authoring map on write and parses it back to a
    // Map on read so it re-serializes with sorted keys per the normalization contract. Nullable
    // to match the canonical DDL (`settings JSONB`, no NOT NULL).
    val settings = jsonb("settings", { it }, { it }).nullable()

    override val primaryKey = PrimaryKey(id)
}
