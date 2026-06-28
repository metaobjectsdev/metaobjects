package com.metaobjects.generator.kotlin

import com.metaobjects.database.CoreDBMetaDataProvider
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MapField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UuidField
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.ANY
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FLOAT
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LIST
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.MAP
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
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
 * Coverage: 7 primitive types + currency + enum + uuid + decimal. R6 Plan 2a: `field.uuid`
 * is a real [UuidField] JVM class, matched by instanceof (native `java.util.UUID` binding).
 * SP-A: `field.decimal` maps to native `java.math.BigDecimal` + Exposed `decimal(p, s)`.
 * Object / class etc. still throw IllegalArgumentException with a clear message; add support
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
     * - `timestamp_with_tz` (on [TimestampField]) — emit the generated, file-local
     *   `instantWithTimeZone("col")` extension (a `Column<java.time.Instant>` whose DDL is
     *   Postgres `timestamp with time zone`). Opt-in: the default for `field.timestamp` is
     *   plain `datetime("col")` (Postgres `timestamp without time zone`, `LocalDateTime`).
     *   NOTE: Exposed 0.55's native `timestampWithTimeZone(...)` is a `Column<OffsetDateTime>`,
     *   which would MISMATCH the `Instant` data-class property emitted by [kotlinTypeName] and
     *   force callers to hand-coerce `Instant`↔`OffsetDateTime`. We therefore emit a custom
     *   `Column<Instant>` column whose `sqlType()` is `TIMESTAMP WITH TIME ZONE` (the helper is
     *   emitted file-locally by [KotlinExposedTableGenerator] — see [EXPOSED_INSTANT_TZ_FN]).
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

    /** `@dbColumnType` values on [StringField] that emit native Postgres array columns
     *  (`uuid[]` / `text[]`) via the Exposed `array<E>("col")` extension. The Kotlin
     *  property becomes `List<UUID>` / `List<String>`. */
    private val DB_COLUMN_TYPE_UUID_ARRAY = CoreDBMetaDataProvider.DB_COLUMN_TYPE_UUID_ARRAY
    private val DB_COLUMN_TYPE_TEXT_ARRAY = CoreDBMetaDataProvider.DB_COLUMN_TYPE_TEXT_ARRAY

    /** FQN of the Exposed `jsonb` extension function (raw-string open-JSON path). */
    private const val EXPOSED_JSONB_IMPORT = "org.jetbrains.exposed.sql.json.jsonb"

    /**
     * Name of the generated, file-local Exposed extension function emitted for a
     * `@dbColumnType=timestamp_with_tz` [TimestampField]. It returns a
     * `Column<java.time.Instant>` whose `sqlType()` is `TIMESTAMP WITH TIME ZONE` — so the
     * column type MATCHES the `Instant` data-class property (zero `Instant`↔`OffsetDateTime`
     * coercion) while keeping the TZ-aware Postgres column (offset→UTC normalization, the
     * persistence-conformance contract). [KotlinExposedTableGenerator] emits the supporting
     * `ColumnType<Instant>` + this extension once per generated table file that needs it; it
     * lives in the table's own package, so no cross-file import is required (the column
     * function returns `null` from [exposedColumnImport]).
     */
    const val EXPOSED_INSTANT_TZ_FN = "instantWithTimeZone"

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

        // Shared-enum naming: when this field `extends` an abstract enum super (e.g. two fields
        // both `extends: Priority`), ALL such fields collapse onto ONE enum class named for the
        // top-most super (`Priority`) so the generated type is shared (and deduped by FQN at
        // emission). Walk the super chain to the root. When there is no super, fall back to the
        // per-entity `<EntityShort><FieldPascal>` naming. Mirrors the C#/TS/Python ports.
        // Collapse onto a SHARED enum type only for a package-level ABSTRACT enum super (FR-019,
        // e.g. two fields `extends: Priority`) — identified by having NO declaring object. A super
        // bound to a CONCRETE entity field (e.g. a read-model projection `extends`-ing
        // `ActiveNpc.status`) does NOT collapse: it falls through to the per-object naming below,
        // so the projection gets its OWN `<ProjectionShort><FieldPascal>` enum in its OWN package
        // (self-contained — no cross-package reference), populated with the values it inherits via
        // `extends` ([KotlinEnumEmitter.readEnumValues] is inheritance-aware). Without this guard
        // such a field named the enum from the super's bare short name (`status`), which `splitFqn`
        // collapsed to a root-package `Status` — colliding across every entity that has a `status`.
        val superRoot = resolveSuperRoot(field)
        if (superRoot != null && runCatching { superRoot.declaringObject }.getOrNull() == null) {
            val (superPkg, superShort) = PackageMapping.splitFqn(superRoot.name)
            return ClassName(superPkg, superShort.replaceFirstChar { it.uppercase() })
        }

        val fieldPascal = field.name.replaceFirstChar { it.uppercase() }
        return if (entity == null) {
            ClassName("", fieldPascal)
        } else {
            val (pkg, entityShort) = PackageMapping.splitFqn(entity.name)
            ClassName(pkg, entityShort + fieldPascal)
        }
    }

    /**
     * Walk a field's `extends` (super-field) chain to the top-most ancestor, returning it, or
     * `null` when the field has no super. The top-most super is an abstract enum declared at the
     * metadata root (e.g. `field.enum Priority @abstract`); naming the generated enum class after
     * it makes every extending field share one type. Defensive against cycles via a visited set.
     */
    private fun resolveSuperRoot(field: EnumField): MetaField<*>? {
        var current: MetaField<*>? = field.superField ?: return null
        val seen = HashSet<String>()
        while (true) {
            val next = current?.superField ?: break
            if (!seen.add(current.name)) break // cycle guard
            current = next
        }
        return current
    }

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when (field) {
        // `@dbColumnType=uuid_array/text_array` makes a field.string a native SQL array,
        // so the property is a List<UUID> / List<String>. Plain strings stay String.
        is StringField    -> when (dbColumnType(field)) {
            DB_COLUMN_TYPE_UUID_ARRAY -> LIST.parameterizedBy(ClassName("java.util", "UUID"))
            DB_COLUMN_TYPE_TEXT_ARRAY -> LIST.parameterizedBy(STRING)
            else -> STRING
        }
        is IntegerField   -> INT
        is LongField      -> LONG
        is DoubleField    -> DOUBLE
        // field.decimal → exact-precision java.math.BigDecimal (NUMERIC/DECIMAL). NEVER a
        // floating type — the whole point of field.decimal is to avoid float rounding.
        is DecimalField   -> ClassName("java.math", "BigDecimal")
        // REAL (float4) — distinct single-precision arm so field.float round-trips as
        // Kotlin Float / Exposed REAL, separate from field.double (float8). See R6.
        is FloatField     -> FLOAT
        is BooleanField   -> BOOLEAN
        is DateField      -> ClassName("java.time", "LocalDate")
        // field.time → java.time.LocalTime / Exposed `time(...)` (Postgres TIME). The
        // wall-clock-only sibling of DateField; the wire form is "HH:MM:SS".
        is TimeField      -> ClassName("java.time", "LocalTime")
        // Default for field.timestamp is `java.time.LocalDateTime` — the zone-less
        // wall-clock shape (Postgres `timestamp without time zone`). The cross-port wire
        // value is zone-less (`yyyy-MM-dd'T'HH:mm:ss`, no `Z`), which a `java.time.Instant`
        // cannot carry — Jackson 400s deserializing it into the DTO. Opt in to
        // `Instant` (UTC instant) via `@dbColumnType=timestamp_with_tz`, paired with the
        // Exposed `timestampWithTimeZone` column. Mirrors the Java SpringTypeMapper fix.
        is TimestampField ->
            if (timestampWithTzOptIn(field)) ClassName("java.time", "Instant")
            else ClassName("java.time", "LocalDateTime")
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
        // field.map → an open-keyed Map<String, V> stored in a single jsonb column.
        // Keys are always String. The value type is the scalar named by @valueType,
        // or (for an @objectRef map) the referenced VO — which needs the loader to
        // resolve, so the VO case is handled by KotlinEntityGenerator.resolveElementType;
        // here the @objectRef branch falls back to Map<String, Any>.
        is MapField       -> MAP.parameterizedBy(STRING, mapValueScalarTypeName(field) ?: ANY)
        else -> throw IllegalArgumentException(
            "unsupported Kotlin type mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * The Kotlin value TypeName for a scalar-valued [MapField] (the type named by its
     * `@valueType` attr — string/int/long/double/float/decimal/boolean/date/time/
     * timestamp/uuid). Returns null when the map carries no `@valueType` (an
     * `@objectRef`-valued map — the VO element type is resolved by the entity generator,
     * which has the loader). The loader has already validated that exactly one of
     * `@valueType` / `@objectRef` is set and that `@valueType` names a scalar subtype.
     */
    fun mapValueScalarTypeName(field: MapField): TypeName? =
        when (stringAttr(field, MapField.ATTR_VALUE_TYPE)) {
            StringField.SUBTYPE_STRING    -> STRING
            IntegerField.SUBTYPE_INT      -> INT
            LongField.SUBTYPE_LONG        -> LONG
            DoubleField.SUBTYPE_DOUBLE    -> DOUBLE
            FloatField.SUBTYPE_FLOAT      -> FLOAT
            DecimalField.SUBTYPE_DECIMAL  -> ClassName("java.math", "BigDecimal")
            BooleanField.SUBTYPE_BOOLEAN  -> BOOLEAN
            DateField.SUBTYPE_DATE        -> ClassName("java.time", "LocalDate")
            TimeField.SUBTYPE_TIME        -> ClassName("java.time", "LocalTime")
            TimestampField.SUBTYPE_TIMESTAMP -> ClassName("java.time", "LocalDateTime")
            UuidField.SUBTYPE_UUID        -> ClassName("java.util", "UUID")
            else -> null
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
        // field.time → Exposed `time(...)` (javatime extension; needs an explicit import,
        // same as `date(...)`).
        is TimeField      -> "org.jetbrains.exposed.sql.javatime.time"
        // Default for field.timestamp is `datetime(...)` — Postgres `timestamp without
        // time zone`, mapped by exposed-java-time to `java.time.LocalDateTime` (the
        // zone-less wall-clock shape carried on the cross-port wire) — needs the javatime
        // `datetime` import. Opt-in `@dbColumnType=timestamp_with_tz` emits the file-local
        // `instantWithTimeZone(...)` extension instead (a `Column<java.time.Instant>` with
        // `TIMESTAMP WITH TIME ZONE` DDL — see [EXPOSED_INSTANT_TZ_FN]). That helper is
        // emitted into the table's own file by [KotlinExposedTableGenerator], so it needs
        // NO external import — return null for the opt-in branch.
        is TimestampField -> {
            if (timestampWithTzOptIn(field)) null
            else "org.jetbrains.exposed.sql.javatime.datetime"
        }
        // `@dbColumnType=jsonb` on a field.string emits the `jsonb(...)` extension, which
        // needs the exposed-json import. `@dbColumnType=uuid` maps to `uuid(...)`, a Table
        // member — no import. All other StringField shapes (varchar/text) are Table members.
        // `uuid_array`/`text_array` emit Exposed's `array<E>("col")` — a Table MEMBER
        // (like uuid/integer), so no import is required (same as the uuid/varchar paths).
        is StringField    ->
            if (dbColumnType(field) == DB_COLUMN_TYPE_JSONB) EXPOSED_JSONB_IMPORT else null
        // field.map emits the `jsonb(...)` extension (single JSONB column), which needs
        // the exposed-json import — same as the `@dbColumnType=jsonb` string path.
        is MapField       -> EXPOSED_JSONB_IMPORT
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
                // Native SQL array columns via Exposed's `array<E>("col", columnType)` Table
                // member. The element ColumnType is explicit (UUIDColumnType / TextColumnType)
                // so emission never depends on Exposed's reified resolveColumnType picking
                // VARCHAR vs TEXT for String. uuid[] / text[] match the migrate-ts DDL.
                DB_COLUMN_TYPE_UUID_ARRAY -> "array<java.util.UUID>(\"$colName\", org.jetbrains.exposed.sql.UUIDColumnType())"
                DB_COLUMN_TYPE_TEXT_ARRAY -> "array<String>(\"$colName\", org.jetbrains.exposed.sql.TextColumnType())"
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
        // field.decimal → Exposed `decimal(name, precision, scale)` (Postgres NUMERIC(p,s)).
        // Exposed requires both precision and scale; read the declared @precision/@scale,
        // falling back to 19,4 (matching the TS column-mapper default) when absent.
        is DecimalField   -> "decimal(\"$colName\", ${decimalPrecision(field)}, ${decimalScale(field)})"
        is BooleanField   -> "bool(\"$colName\")"
        is DateField      -> "date(\"$colName\")"
        // field.time → Exposed `time(name)` (Postgres TIME, java.time.LocalTime).
        is TimeField      -> "time(\"$colName\")"
        // Default for field.timestamp is `datetime(...)` — Postgres `timestamp without
        // time zone` (`java.time.LocalDateTime`), the zone-less wall-clock wire shape.
        // Opt in to TZ-aware (`java.time.Instant`) via `@dbColumnType=timestamp_with_tz`,
        // which emits the file-local `instantWithTimeZone(...)` extension — a
        // `Column<java.time.Instant>` (matches the Instant data class) whose DDL is
        // `TIMESTAMP WITH TIME ZONE` (see [EXPOSED_INSTANT_TZ_FN]).
        is TimestampField -> {
            if (timestampWithTzOptIn(field)) "$EXPOSED_INSTANT_TZ_FN(\"$colName\")"
            else "datetime(\"$colName\")"
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
        // field.map → a single Postgres `JSONB` column holding the JSON object. Same
        // emission as a `field.object` jsonb column (the typed-object JSONB path) — the
        // Exposed `jsonb(name, encoder, decoder)` extension with kotlinx.serialization
        // Json. Never flattened; isArray does not apply to a map. (Map columns are
        // normally produced by KotlinExposedTableGenerator.buildObjectColumns; this arm
        // keeps the mapper total for direct callers.)
        is MapField       ->
            "jsonb(\"$colName\", { Json.encodeToString(it) }, { Json.decodeFromString(it) })"
        else -> throw IllegalArgumentException(
            "unsupported Exposed column mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * Read the `@dbColumnType` attribute (case-folded) for column-type overrides. Resolved
     * THROUGH the `extends` super-field chain (`includeParent = true`), so an `object.projection`
     * field that binds a base-entity column via `extends:` inherits that column's physical type
     * (uuid / text_array / timestamp_with_tz) — exactly as it already inherits `@maxLength` (see
     * [stringMaxLength]). Own value still wins (checked first by [MetaData.hasMetaAttr]).
     * Returns null when absent. See [ATTR_DB_COLUMN_TYPE] for recognised values.
     */
    private fun dbColumnType(field: MetaField<*>): String? =
        stringAttr(field, ATTR_DB_COLUMN_TYPE, includeParent = true)?.lowercase()

    /**
     * True iff [field] carries `@dbColumnType=timestamp_with_tz` (case-insensitive).
     * Centralised so the type spec and the import set stay in lockstep — both call this.
     */
    private fun timestampWithTzOptIn(field: MetaField<*>): Boolean =
        dbColumnType(field) == DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ

    /**
     * True iff [field] is a [TimestampField] that opted in to the TZ-aware
     * `@dbColumnType=timestamp_with_tz` column. [KotlinExposedTableGenerator] uses this to
     * decide whether a table file must carry the file-local `instantWithTimeZone(...)`
     * support helper (the custom `Column<java.time.Instant>` / `TIMESTAMP WITH TIME ZONE`
     * column type). Non-timestamp fields are always false.
     */
    fun usesInstantWithTimeZone(field: MetaField<*>): Boolean =
        field is TimestampField && timestampWithTzOptIn(field)

    /**
     * Best-effort read of a named string attribute on [field] (own-only by default;
     * [includeParent] = true also walks the `extends` super-field chain). Returns null when
     * the attribute is absent, throws during lookup, or isn't a [com.metaobjects.attr.MetaAttribute].
     * Used for non-typed dispatch keys (e.g. `@kind`) that aren't part of the registered
     * StringField attribute schema.
     */
    private fun stringAttr(field: MetaField<*>, name: String, includeParent: Boolean = false): String? {
        if (!field.hasMetaAttr(name, includeParent)) return null
        val attr = runCatching {
            field.getMetaAttr(name, includeParent)
        }.getOrNull() as? com.metaobjects.attr.MetaAttribute<*> ?: return null
        return attr.valueAsString
    }

    /**
     * Default NUMERIC precision when a [DecimalField] declares no `@precision`. Matches the
     * TS column-mapper fallback so a decimal with no precision/scale lands on the same
     * physical NUMERIC(19,4) shape across ports.
     */
    private const val DECIMAL_DEFAULT_PRECISION = 19

    /** Default NUMERIC scale when a [DecimalField] declares no `@scale`. See [DECIMAL_DEFAULT_PRECISION]. */
    private const val DECIMAL_DEFAULT_SCALE = 4

    /** Resolve @precision on a DecimalField; default [DECIMAL_DEFAULT_PRECISION]. */
    private fun decimalPrecision(field: DecimalField): Int =
        intAttr(field, DecimalField.ATTR_PRECISION) ?: DECIMAL_DEFAULT_PRECISION

    /** Resolve @scale on a DecimalField; default [DECIMAL_DEFAULT_SCALE]. */
    private fun decimalScale(field: DecimalField): Int =
        intAttr(field, DecimalField.ATTR_SCALE) ?: DECIMAL_DEFAULT_SCALE

    /** Best-effort read of a named int-valued attribute (own-only) on [field]; null when absent/unparseable. */
    private fun intAttr(field: MetaField<*>, name: String): Int? {
        if (!field.hasMetaAttr(name, false)) return null
        val raw = runCatching { field.getMetaAttr(name, false).value }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull()
            else -> null
        }
    }

    /** Resolve @maxLength on a StringField; default 255. */
    private fun stringMaxLength(field: StringField): Int {
        if (!field.hasMetaAttr(StringField.ATTR_MAX_LENGTH, true)) return 255
        val raw = runCatching {
            field.getMetaAttr(StringField.ATTR_MAX_LENGTH, true).value
        }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull() ?: 255
            else -> 255
        }
    }
}
