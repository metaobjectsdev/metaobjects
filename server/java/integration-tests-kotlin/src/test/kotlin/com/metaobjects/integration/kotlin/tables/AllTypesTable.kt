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
 *   - `field.enum` + `@intValueMap` (int-backed)        → `intBackedEnum("intEnumVal", …)` (INTEGER + int CHECK)
 *   - `field.uuid` (non-key, @required)                 → `uuid("uuidVal")` (Postgres native uuid)
 *   - `field.object` (@objectRef Settings, @storage jsonb) → `jsonb("settings", …)` (real Postgres JSONB)
 *   - `field.object` (@objectRef Label, @storage jsonb, isArray) → `jsonb("labels", …)` (JSONB array)
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
    // INT-BACKED `field.enum` (@intValueMap): physically INTEGER (+ the canonical DDL's
    // CHECK (… IN (0, 5, 9))), carrying the member SYMBOL in and out — storage changes, the
    // wire format does not. Nullable to match the canonical DDL (`"intEnumVal" INTEGER`, no
    // NOT NULL). See [IntBackedEnumColumnType] for why this is a Column<String> here while the
    // GENERATED form binds a real enum through customEnumeration.
    val intEnumVal =
        intBackedEnum("intEnumVal", mapOf("DRAFT" to 0, "PUBLISHED" to 5, "ARCHIVED" to 9)).nullable()
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
    //
    // NOTE ON CODEC DIVERGENCE: this cross-port persistence oracle uses the RAW-JSON-STRING
    // identity `jsonb(name, { it }, { it })` codec (Column<String>) — the generic runner
    // pre-serializes the authoring value to a JSON string on write and re-parses it on read, so
    // the column is String-typed by design and shared across every jsonb column here. The GENERATED
    // KotlinExposedTableGenerator now emits a TYPED Jackson codec instead
    // (`jsonb(name, { metaJsonbMapper.writeValueAsString(it) }, { metaJsonbMapper.readValue(...) })`,
    // Column<VO>/Column<List<VO>>). That generated form is compiled + round-tripped against
    // Testcontainers PG by com.metaobjects.integration.kotlin.tables.jsonb.GeneratedTypedJsonbRoundTripTest;
    // reproducing the typed codec here would require the generic runner to bind typed VO instances,
    // which it deliberately does not.
    val settings = jsonb("settings", { it }, { it }).nullable()

    // `@storage:jsonb` @isArray owned-object column (`labels`, an array of the `Label` VO). Same
    // raw-JSON-String identity codec as `settings`: the runner serializes the authoring List on
    // write and parses it back to a List on read. An empty JSON array `[]` round-trips distinct
    // from null. Nullable to match the canonical DDL (`labels JSONB`, no NOT NULL).
    val labels = jsonb("labels", { it }, { it }).nullable()

    override val primaryKey = PrimaryKey(id)
}
