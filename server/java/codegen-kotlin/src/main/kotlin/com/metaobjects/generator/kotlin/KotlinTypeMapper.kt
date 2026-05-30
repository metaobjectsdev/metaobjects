package com.metaobjects.generator.kotlin

import com.metaobjects.database.CoreDBMetaDataProvider
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UuidField
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FLOAT
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName

/**
 * Centralized mapping from MetaField subtype to (a) KotlinPoet TypeName for data class
 * properties and (b) the Exposed `Table` column statement.
 *
 * Per the codegen-kotlin spec §6 (type mapping table). Tier-1 invariant: the *semantic*
 * type per field subtype is identical across all language ports. The exact Kotlin/Exposed
 * names are Tier-2 idiomatic per port.
 *
 * Coverage: 7 primitive types + currency + enum + uuid. R6 Plan 2a: `field.uuid` is a real
 * [UuidField] JVM class, matched by instanceof (native `java.util.UUID` binding). Object /
 * class / decimal etc. still throw IllegalArgumentException with a clear message; add support
 * per real consumer ask.
 */
object KotlinTypeMapper {

    /** Default VARCHAR width for string-backed `field.enum` storage (v1). */
    const val ENUM_VARCHAR_LEN = 64

    /**
     * Threshold beyond which a [StringField]'s `@maxLength` is treated as unbounded text and
     * emitted as Exposed `text(name)` rather than `varchar(name, N)`. Chosen at 4000 — the
     * customary Postgres inline-VARCHAR cutoff (TOAST boundary); larger values are better
     * served by `TEXT`, which Exposed maps to `text(name)`.
     */
    private const val VARCHAR_TEXT_THRESHOLD = 4000

    /** Sentinel `@kind` value on a [StringField] that forces `text(name)` emission. */
    private const val KIND_TEXT = "text"

    /** Attribute name read off a [StringField] to dispatch to `text(name)` (kind=text). */
    private const val ATTR_KIND = "kind"

    /**
     * Attribute name read off any field to override the default Exposed column type
     * (R6 Plan 2b — the registered physical `@dbColumnType` attr on the `dbProvider`,
     * [CoreDBMetaDataProvider.DB_COLUMN_TYPE]). The loader has already validated the
     * (logical subtype × value) pairing against the closed set; here we only ROUTE the
     * already-legal value to the matching Exposed column. Recognised values
     * (case-insensitive), all leaving the Kotlin data-class property type unchanged:
     * - `uuid` (on [StringField]) — emit Exposed `uuid("col")` instead of `varchar("col", N)`.
     *   Postgres maps this to the native `uuid` column type; the property stays `String`
     *   (Exposed coerces String ↔ uuid at the SQL boundary).
     * - `jsonb` (on [StringField]) — emit Exposed `jsonb("col", { it }, { it })` (a real
     *   Postgres `JSONB` column). The property stays a raw-JSON `String`; the identity
     *   encode/decode functions pass the JSON text straight through.
     * - `timestamp_with_tz` (on [TimestampField]) — emit Exposed `timestampWithTimeZone("col")`
     *   (Postgres `timestamp with time zone`). Opt-in: the default for `field.timestamp` is
     *   plain `timestamp("col")` (Postgres `timestamp without time zone`).
     *
     * Unknown values fall through to the default mapping for the field type.
     */
    private val ATTR_DB_COLUMN_TYPE = CoreDBMetaDataProvider.DB_COLUMN_TYPE

    /** `@dbColumnType` value on [StringField] that selects Exposed `uuid("col")`. */
    private val DB_COLUMN_TYPE_UUID = CoreDBMetaDataProvider.DB_COLUMN_TYPE_UUID

    /**
     * `@dbColumnType` value on [StringField] that emits a real Postgres `JSONB` column
     * (matching the other ports). The Kotlin property stays a raw-JSON `String`; the
     * Exposed `jsonb(name, encoder, decoder)` extension is emitted with identity
     * String encode/decode so the raw JSON text passes straight through.
     *
     * Note: this is the **raw-string** open-JSON path for `field.string`. The
     * typed-object JSONB path on `field.object` (`@storage=jsonb`) lives in
     * [KotlinExposedTableGenerator]'s object-column emission and uses
     * `jsonb("col", encoder, decoder)` with kotlinx.serialization.
     */
    private val DB_COLUMN_TYPE_JSONB = CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB

    /** `@dbColumnType` value on [TimestampField] that opts in to Exposed `timestampWithTimeZone("col")`. */
    private val DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ = CoreDBMetaDataProvider.DB_COLUMN_TYPE_TIMESTAMP_TZ

    /** FQN of the Exposed `jsonb` extension function (raw-string open-JSON path). */
    private const val EXPOSED_JSONB_IMPORT = "org.jetbrains.exposed.sql.json.jsonb"

    /**
     * Compute the generated Kotlin enum-class name for an [EnumField] hung off [entity].
     *
     * Returns {@code null} when [field] is not an {@link EnumField} (the caller should
     * fall through to the generic [kotlinTypeName] mapping). Naming rule:
     * {@code <EntityShortName><FieldNamePascalCase>}, in the same Kotlin package as the
     * entity (derived from the entity's metadata FQN via [PackageMapping.splitFqn]).
     *
     * Entity-prefixing prevents collisions across entities (e.g., {@code Player.status} →
     * {@code PlayerStatus}; {@code Game.status} → {@code GameStatus}). When [entity] is
     * null (e.g., bare-mapper unit tests) the enum class is rendered with no package
     * prefix and no entity-name prefix — only the field name pascalised — so the helper
     * still produces a useful ClassName for documentation / debug output. Generators that
     * actually emit code always pass the owning entity.
     */
    fun enumTypeName(field: MetaField<*>, entity: MetaObject?): ClassName? {
        if (field !is EnumField) return null
        val fieldPascal = field.name.replaceFirstChar { it.uppercase() }
        return if (entity == null) {
            ClassName("", fieldPascal)
        } else {
            val (pkg, entityShort) = PackageMapping.splitFqn(entity.name)
            ClassName(pkg, entityShort + fieldPascal)
        }
    }

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when (field) {
        is StringField    -> STRING
        is IntegerField   -> INT
        is LongField      -> LONG
        is DoubleField    -> DOUBLE
        // REAL (float4) — distinct single-precision arm so field.float round-trips as
        // Kotlin Float / Exposed REAL, separate from field.double (float8). See R6.
        is FloatField     -> FLOAT
        is BooleanField   -> BOOLEAN
        is DateField      -> ClassName("java.time", "LocalDate")
        is TimestampField -> ClassName("java.time", "Instant")
        // Currency: integer minor units on the wire (project-wide invariant). Same JVM
        // representation as Long; surfaced as its own arm so the semantic is documented
        // and downstream tooling can branch on subtype.
        is CurrencyField  -> LONG
        // Enum (string-backed v1): emit as Kotlin String. Generating a real enum class
        // requires materialising the `@values` set into a top-level declaration — deferred
        // until the enum-class generator lands (see field-constants enum design doc).
        is EnumField      -> STRING
        // field.uuid → native java.util.UUID property (R6 Plan 2a). `@dbColumnType=uuid`
        // on a field.string is the separate physical escape hatch and keeps the String
        // property — handled by the StringField arm, not here.
        is UuidField      -> ClassName("java.util", "UUID")
        else -> throw IllegalArgumentException(
            "unsupported Kotlin type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * Map a MetaField to the Exposed `Table` column statement (e.g., `varchar("name", 100)`).
     *
     * The default physical column name is [field.name] snake_case-d (Postgres convention:
     * `displayName` → `display_name`). Callers needing a verbatim column name (or a custom
     * one — e.g., the flattened `@storage` path that prefix-joins parent + sub field) use
     * the two-arg overload [exposedColumnSpec] and pass the column name explicitly.
     */
    fun exposedColumnSpec(field: MetaField<*>): String =
        exposedColumnSpec(field, KotlinGenUtil.camelToSnake(field.name))

    /**
     * Return the fully-qualified import required for the Exposed column function this
     * field maps to, or `null` when the column function is a member of [org.jetbrains.exposed.sql.Table]
     * (no import beyond `Table` itself needed).
     *
     * Used by [KotlinExposedTableGenerator] to assemble the per-file import block — without
     * this, generated tables that use `date(...)`, `timestampWithTimeZone(...)`, etc.
     * compile-fail with unresolved-reference errors. Extension functions from the
     * `org.jetbrains.exposed.sql.javatime` package must be imported explicitly.
     *
     * Returns `null` for column functions that are members of `Table` itself
     * (`varchar`, `integer`, `long`, `double`, `bool`, `text`, `uuid`, `enumerationByName`,
     * `binary`) — those are inherited by the `object FooTable : Table(...)` declaration
     * and don't need their own import line.
     */
    fun exposedColumnImport(field: MetaField<*>): String? = when (field) {
        is DateField      -> "org.jetbrains.exposed.sql.javatime.date"
        // Default for field.timestamp is plain `timestamp(...)` (Postgres `timestamp
        // without time zone` — the more common shape). Opt-in `@dbColumnType=timestamp_with_tz`
        // switches to `timestampWithTimeZone(...)` (Postgres `timestamp with time zone`).
        is TimestampField -> {
            if (timestampWithTzOptIn(field))
                "org.jetbrains.exposed.sql.javatime.timestampWithTimeZone"
            else
                "org.jetbrains.exposed.sql.javatime.timestamp"
        }
        // `@dbColumnType=jsonb` on a field.string emits the `jsonb(...)` extension, which
        // needs the exposed-json import. `@dbColumnType=uuid` maps to `uuid(...)`, a Table
        // member — no import. All other StringField shapes (varchar/text) are Table members.
        is StringField    ->
            if (dbColumnType(field) == DB_COLUMN_TYPE_JSONB) EXPOSED_JSONB_IMPORT else null
        // IntegerField, LongField, DoubleField, FloatField, BooleanField, CurrencyField,
        // EnumField, and UuidField all map to member functions on Table.
        // No additional import required.
        else -> null
    }

    /**
     * Same as [exposedColumnSpec], but with an explicit physical column name. Used by the
     * `@storage: "flattened"` codepath to emit prefixed columns (e.g., `address_street`)
     * for nested object.value fields without mutating the underlying MetaField.
     */
    fun exposedColumnSpec(field: MetaField<*>, colName: String): String = when (field) {
        is StringField    -> {
            // `@dbColumnType=uuid` opt-in: emit `uuid("col")` instead of varchar. The Kotlin
            // data class property stays `String` for now (Exposed coerces String ↔ uuid at
            // the SQL boundary), so adopters can convert a string-shaped FK column to the
            // native Postgres uuid type without changing their data class shape.
            //
            // `@dbColumnType=jsonb` opt-in: emit a real Postgres `JSONB` column via the
            // Exposed `jsonb(name, encoder, decoder)` extension with identity String
            // functions (the property stays raw-JSON `String`; the JSON text passes
            // straight through). Matches the other ports' JSONB emission — a TEXT column
            // would never round-trip to JSONB through the introspection corpus.
            when (dbColumnType(field)) {
                DB_COLUMN_TYPE_UUID  -> "uuid(\"$colName\")"
                DB_COLUMN_TYPE_JSONB -> "jsonb(\"$colName\", { it }, { it })"
                else -> {
                    // Dispatch to Exposed `text(name)` when the field is declared as unbounded text:
                    //   (1) explicit `@kind: "text"` opt-in, OR
                    //   (2) `@maxLength` exceeds the VARCHAR/TEXT cutoff (Postgres TOAST boundary).
                    // Otherwise emit `varchar(name, N)` with N defaulting to 255.
                    val kind = stringAttr(field, ATTR_KIND)
                    val maxLen = stringMaxLength(field)
                    if (kind == KIND_TEXT || maxLen > VARCHAR_TEXT_THRESHOLD) "text(\"$colName\")"
                    else "varchar(\"$colName\", $maxLen)"
                }
            }
        }
        is IntegerField   -> "integer(\"$colName\")"
        is LongField      -> "long(\"$colName\")"
        is DoubleField    -> "double(\"$colName\")"
        // Exposed `float(name)` maps to Postgres REAL (float4); `double` maps to
        // DOUBLE PRECISION (float8). Keeps field.float distinct on the wire. See R6.
        is FloatField     -> "float(\"$colName\")"
        is BooleanField   -> "bool(\"$colName\")"
        is DateField      -> "date(\"$colName\")"
        // Default for field.timestamp is plain `timestamp(...)` — Postgres `timestamp
        // without time zone` is the more common shape. Opt in to TZ-aware via
        // `@dbColumnType=timestamp_with_tz`.
        is TimestampField -> {
            if (timestampWithTzOptIn(field)) "timestampWithTimeZone(\"$colName\")"
            else "timestamp(\"$colName\")"
        }
        // Currency stored as BIGINT minor units — same as Long. Separate arm for
        // semantic clarity (a future migration generator can branch on it).
        is CurrencyField  -> "long(\"$colName\")"
        // Enum stored as VARCHAR for v1. Proper enum-column handling needs the generated
        // enum class (Exposed's `customEnumeration` / `enumerationByName` takes a KClass<E>)
        // and is intentionally deferred.
        is EnumField      -> "varchar(\"$colName\", $ENUM_VARCHAR_LEN)"
        // field.uuid → Exposed's first-class `uuid(name)` (native Postgres uuid column).
        // R6 Plan 2a: matched by instanceof now that UuidField is a real JVM class.
        is UuidField      -> "uuid(\"$colName\")"
        else -> throw IllegalArgumentException(
            "unsupported Exposed column mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * Read the `@dbColumnType` attribute (own-only, case-folded) for column-type overrides.
     * Returns null when absent. See [ATTR_DB_COLUMN_TYPE] for recognised values.
     */
    private fun dbColumnType(field: MetaField<*>): String? =
        stringAttr(field, ATTR_DB_COLUMN_TYPE)?.lowercase()

    /**
     * True iff [field] carries `@dbColumnType=timestamp_with_tz` (case-insensitive).
     * Centralised so the type spec and the import set stay in lockstep — both call this.
     */
    private fun timestampWithTzOptIn(field: MetaField<*>): Boolean =
        dbColumnType(field) == DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ

    /**
     * Best-effort read of a named string attribute (own-only) on [field]. Returns null when
     * the attribute is absent, throws during lookup, or isn't a [com.metaobjects.attr.MetaAttribute].
     * Used for non-typed dispatch keys (e.g. `@kind`) that aren't part of the registered
     * StringField attribute schema.
     */
    private fun stringAttr(field: MetaField<*>, name: String): String? {
        if (!field.hasMetaAttr(name, false)) return null
        val attr = runCatching {
            field.getMetaAttr(name, false)
        }.getOrNull() as? com.metaobjects.attr.MetaAttribute<*> ?: return null
        return attr.valueAsString
    }

    /** Resolve @maxLength on a StringField; default 255. */
    private fun stringMaxLength(field: StringField): Int {
        if (!field.hasMetaAttr(StringField.ATTR_MAX_LENGTH, false)) return 255
        val raw = runCatching {
            field.getMetaAttr(StringField.ATTR_MAX_LENGTH, false).value
        }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: 255
            else -> 255
        }
    }
}
