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
import com.metaobjects.field.UriField
import com.metaobjects.field.InetField
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

    /**
     * Attribute name read off any field to override the default Exposed column type
     * (R6 Plan 2b — the registered physical `@dbColumnType` attr on the `dbProvider`,
     * [CoreDBMetaDataProvider.DB_COLUMN_TYPE]). The loader has already validated the
     * (logical subtype × value) pairing against the closed set; here we only ROUTE the
     * already-legal value to the matching Exposed column. Recognised values
     * (case-insensitive), all leaving the Kotlin data-class property type unchanged:
     * - `uuid` (on [StringField]) — emit Exposed `uuid("col")` instead of `text("col")`.
     *   Postgres maps this to the native `uuid` column type; the property stays `String`
     *   (Exposed coerces String ↔ uuid at the SQL boundary). The narrow "uuid column +
     *   String native type" escape hatch; `field.uuid` is preferred when a native UUID
     *   property is wanted.
     * - `jsonb` (on [StringField]) — emit Exposed `jsonb("col", { it }, { it })` (a real
     *   Postgres `JSONB` column). The property stays a raw-JSON `String`; the identity
     *   encode/decode functions pass the JSON text straight through.
     * Timestamp timezone-awareness is NOT a `@dbColumnType` value anymore (ADR-0036
     * Wave 2): a `field.timestamp` is an absolute INSTANT (`Column<java.time.Instant>`,
     * file-local `instantWithTimeZone("col")`, Postgres `timestamp with time zone`) by
     * DEFAULT, and the `@localTime:true` boolean is the rare naive opt-out (plain
     * `datetime("col")`, Postgres `timestamp without time zone`, `LocalDateTime`). See
     * [localTimeOptIn] / [EXPOSED_INSTANT_TZ_FN].
     *
     * Unknown values fall through to the default mapping for the field type.
     */
    private val ATTR_DB_COLUMN_TYPE = CoreDBMetaDataProvider.DB_COLUMN_TYPE

    /** `@localTime` boolean attr on [TimestampField] — ADR-0036 Wave 2 naive opt-out. */
    private val ATTR_LOCAL_TIME = CoreDBMetaDataProvider.LOCAL_TIME

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
     * `jsonb("col", encoder, decoder)` with the shared Jackson `metaJsonbMapper`.
     */
    private val DB_COLUMN_TYPE_JSONB = CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB

    /** FQN of the Exposed `jsonb` extension function (raw-string open-JSON path). */
    private const val EXPOSED_JSONB_IMPORT = "org.jetbrains.exposed.sql.json.jsonb"

    /**
     * The kotlinx-serialization JSON-value type a `field.string @dbColumnType=jsonb` open-bag is
     * exposed as (issue #98). `JsonElement` is the idiomatic "any JSON value" type — kotlinx is
     * still this port's payload substrate (the FR-006 prompt payloads + enums), and its runtime
     * `Json.parseToJsonElement` needs no compiler plugin. (The typed `field.object` / `field.map`
     * jsonb columns, by contrast, now use the shared Jackson `metaJsonbMapper`, not kotlinx.) So a
     * client sends/receives a real JSON object rather than a double-encoded string.
     *
     * Used UNIFORMLY at every layer — the persistence holder ([kotlinTypeName], i.e. the entity
     * data class reused as the entity-CRUD DTO), the REST payload ([payloadTypeName]), and the
     * Exposed column codec ([exposedColumnSpec], which decodes the JSONB text to a `JsonElement`).
     * Matching the maintainer decision on #98: uniform parsed value at the API boundary across all
     * ports (TS `z.unknown()`, Python `Any`, C# `JsonDocument`). The wire/serialized form stays
     * byte-identical to those ports (`{...}`); only the in-process Kotlin type is `JsonElement`.
     */
    private val JSON_VALUE_TYPE = ClassName("kotlinx.serialization.json", "JsonElement")

    /**
     * Name of the generated, file-local Exposed extension function emitted for an
     * instant (default, non-`@localTime`) [TimestampField]. It returns a
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
     * Name of the generated, file-local Exposed extension function emitted for a
     * [UriField] (ADR-0036/0037 Wave 3). Returns a `Column<java.net.URI>` whose
     * `sqlType()` is `text` (Postgres has no uri type), so the column type MATCHES the
     * `java.net.URI` data-class property while persisting plain text.
     * [KotlinExposedTableGenerator] emits the supporting `ColumnType<URI>` + this extension
     * into the package-shared [MetaInetUriColumnType] support file.
     */
    const val EXPOSED_URI_FN = "uriColumn"

    /**
     * Name of the generated, file-local Exposed extension function emitted for an
     * [InetField] (ADR-0036/0037 Wave 3). Returns a `Column<java.net.InetAddress>` whose
     * `sqlType()` is the Postgres-native `inet`, so the column type MATCHES the
     * `java.net.InetAddress` data-class property while using the native inet column.
     * [KotlinExposedTableGenerator] emits the supporting `ColumnType<InetAddress>` + this
     * extension into the package-shared [MetaInetUriColumnType] support file.
     */
    const val EXPOSED_INET_FN = "inetColumn"

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

        // Shared-enum naming: when this field `extends` a package-level ABSTRACT enum super (e.g.
        // two fields both `extends: Priority`), ALL such fields collapse onto ONE enum class named
        // for the top-most super (`Priority`) so the generated type is shared (and deduped by FQN at
        // emission). When there is no super, fall back to the per-entity `<EntityShort><FieldPascal>`
        // naming. Mirrors the C#/TS/Python ports.
        //
        // The collapse decision keys on the DIRECT (immediate) super, NOT the top-most root: collapse
        // onto a SHARED enum type ONLY when the field's IMMEDIATE `extends` target is a package-level
        // abstract enum — identified by having NO declaring object. A field whose direct super is a
        // CONCRETE entity/projection field (e.g. a read-model projection `extends`-ing `ActiveNpc.status`)
        // does NOT collapse — even when that entity field itself `extends` a shared abstract enum (#259,
        // the two-hop case): it falls through to the per-object naming below, so the projection gets its
        // OWN `<ProjectionShort><FieldPascal>` enum in its OWN package (self-contained — no cross-package
        // reference), populated with the values it inherits via `extends` ([KotlinEnumEmitter.readEnumValues]
        // is inheritance-aware across ANY number of hops). Keying on the top-most root instead (an earlier
        // bug) walked PAST the concrete entity super to the shared abstract root and wrongly collapsed the
        // projection onto the shared type, so its per-projection enum was never emitted. Without any guard
        // at all, a concrete-super field named the enum from the super's bare short name (`status`), which
        // `splitFqn` collapsed to a root-package `Status` — colliding across every entity with a `status`.
        val immediateSuper = field.superField
        if (immediateSuper != null && runCatching { immediateSuper.declaringObject }.getOrNull() == null) {
            // The DIRECT super is a package-level abstract enum → collapse onto the shared type, named
            // for THAT declaration — the immediate super, NOT the top-most root of an abstract chain.
            //
            // Naming by the top-most root (the previous behaviour) contradicted this file's own FR-019
            // arm, which resolves the shared declaration from the IMMEDIATE super
            // ([Fr019SharedEnum.resolveSharedEnumDecl]) exactly as TS/C#/Java/Python do. On a CHAINED
            // declaration (root abstract `Money extends` root abstract `@provided Currency`) the two
            // halves disagreed: the materialize-vs-reference decision saw `Money` (own @provided absent
            // → materialize) while the NAME collapsed to `Currency`, so Kotlin emitted a local
            // `Currency.kt` that collided with the `com.acme.ext.Currency` reference emitted for fields
            // extending `Currency` directly.
            //
            // Per ADR-0026 §2 a materialized type is named for ITS OWN declaration, so a chain yields one
            // type per declaration, each carrying the member set it inherits ([KotlinEnumEmitter
            // .readEnumValues] is inheritance-aware across any number of hops). #246 guarantees a chained
            // declaration can never MUTATE the vocabulary it inherits — it may rename it, nothing more.
            //
            // Non-chained output is byte-identical: with no further super the root walk returned the
            // immediate super anyway. The #259 two-hop projection guard is the `declaringObject == null`
            // condition above, which is evaluated FIRST and is unaffected.
            val (superPkg, superShort) = PackageMapping.splitFqn(immediateSuper.name)
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

    /** Map a MetaField to its KotlinPoet data-class property TypeName. */
    fun kotlinTypeName(field: MetaField<*>): TypeName = when (field) {
        // This is the SCALAR/element mapper — `isArray` List<…> wrapping is applied by the
        // CALLERS (entity + payload generators), so a `field.string`'s element type is plain
        // String even when isArray (the column DDL `text[]` is derived separately in
        // [exposedColumnSpec]). `@dbColumnType=jsonb` is the open JSON bag — a parsed JSON value
        // (kotlinx `JsonElement`, issue #98), uniform with the payload + Exposed column codec so
        // the entity-CRUD DTO is never a double-encoded String. Plain strings stay String.
        is StringField    ->
            if (dbColumnType(field) == DB_COLUMN_TYPE_JSONB) JSON_VALUE_TYPE else STRING
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
        // Default for field.timestamp is `java.time.Instant` — an absolute UTC instant
        // (Postgres `timestamp with time zone`), whose cross-port wire value carries a
        // `Z` (ADR-0036 Wave 2). The rare `@localTime:true` naive opt-out is the zone-less
        // wall-clock shape (`yyyy-MM-dd'T'HH:mm:ss`, no `Z`), which is `java.time.LocalDateTime`
        // (an Instant cannot carry a zone-less wall clock — Jackson 400s on it), paired with
        // the Exposed `datetime` column. Mirrors the Java SpringTypeMapper flip.
        is TimestampField ->
            if (localTimeOptIn(field)) ClassName("java.time", "LocalDateTime")
            else ClassName("java.time", "Instant")
        // Currency: integer minor units on the wire (project-wide invariant). Same JVM
        // representation as Long; surfaced as its own arm so the semantic is documented
        // and downstream tooling can branch on subtype.
        is CurrencyField  -> LONG
        // Enum (string-backed v1): emit as Kotlin String. Generating a real enum class
        // requires materialising the `@values` set into a top-level declaration — deferred
        // until the enum-class generator lands (see field-constants enum design doc).
        is EnumField      -> STRING
        // field.uuid → native java.util.UUID property (R6 Plan 2a). This is the SCALAR/element
        // type — `isArray` List<UUID> wrapping is applied by the callers; the native `uuid[]`
        // column DDL is derived separately in [exposedColumnSpec]. `@dbColumnType=uuid` on a
        // field.string is the separate physical escape hatch and keeps the String property —
        // handled by the StringField arm, not here.
        is UuidField      -> ClassName("java.util", "UUID")
        // field.uri → native java.net.URI property (ADR-0036/0037 Wave 3). The DB column is
        // plain text (Postgres has no uri type); the file-local `uriColumn(...)` extension
        // gives a `Column<URI>` so the property and column types match.
        // #234: a @lenient field.uri degrades to a plain String (no native URI type, no validator).
        is UriField       -> if (lenientNetField(field)) STRING else ClassName("java.net", "URI")
        // field.inet → native java.net.InetAddress property (ADR-0036/0037 Wave 3). The DB
        // column is the Postgres-native inet type; the file-local `inetColumn(...)` extension
        // gives a `Column<InetAddress>`. #234: a @lenient field.inet degrades to a plain String.
        is InetField      -> if (lenientNetField(field)) STRING else ClassName("java.net", "InetAddress")
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
     * True iff [field] is the `field.string @dbColumnType=jsonb` open JSON bag — the sanctioned
     * "arbitrary JSON value" pattern whose physical column is JSONB while its logical subtype stays
     * `string`. The single source of truth both the payload type ([payloadTypeName]) and the
     * extract-mapper bridge ([KotlinExtractorGenerator]) dispatch on, so the two sites stay in
     * lockstep. Resolved THROUGH the `extends` chain (same as [dbColumnType]) so a projection field
     * that binds a base-entity jsonb column via `extends:` inherits the open-bag treatment.
     */
    fun isJsonbOpenBag(field: MetaField<*>): Boolean =
        field is StringField && dbColumnType(field) == DB_COLUMN_TYPE_JSONB

    /**
     * Map a MetaField to its KotlinPoet TypeName for a REST/serialization **payload** property
     * (the `@Serializable` projection data classes emitted by [KotlinPayloadGenerator]).
     *
     * For the `field.string @dbColumnType=jsonb` open bag this is the parsed JSON value
     * [JSON_VALUE_TYPE] (issue #98). As of the #98 uniform-parsed-value cutover this now AGREES
     * with [kotlinTypeName] at every subtype — the persistence holder (entity data class reused as
     * the entity-CRUD DTO) and the Exposed column ([exposedColumnSpec]) ALSO expose the bag as a
     * `JsonElement`, so there is no longer a payload/persistence split. Retained as a distinct,
     * intention-revealing entry point for the payload generators (and to keep them robust if the
     * two surfaces ever diverge again).
     */
    fun payloadTypeName(field: MetaField<*>): TypeName =
        if (isJsonbOpenBag(field)) JSON_VALUE_TYPE else kotlinTypeName(field)

    /**
     * The Kotlin value TypeName for a scalar-valued [MapField] (the type named by its
     * `@valueType` attr — string/int/long/double/float/decimal/boolean/date/time/
     * timestamp/uuid). Returns null when the map carries no `@valueType` (an
     * `@objectRef`-valued map — the VO element type is resolved by the entity generator,
     * which has the loader). The loader has already validated that exactly one of
     * `@valueType` / `@objectRef` is set and that `@valueType` names a scalar subtype.
     */
    fun mapValueScalarTypeName(field: MapField): TypeName? =
        // ADR-0039: @valueType is an effective property — resolve through extends.
        when (stringAttr(field, MapField.ATTR_VALUE_TYPE, includeParent = true)) {
            StringField.SUBTYPE_STRING    -> STRING
            IntegerField.SUBTYPE_INT      -> INT
            LongField.SUBTYPE_LONG        -> LONG
            DoubleField.SUBTYPE_DOUBLE    -> DOUBLE
            FloatField.SUBTYPE_FLOAT      -> FLOAT
            DecimalField.SUBTYPE_DECIMAL  -> ClassName("java.math", "BigDecimal")
            BooleanField.SUBTYPE_BOOLEAN  -> BOOLEAN
            DateField.SUBTYPE_DATE        -> ClassName("java.time", "LocalDate")
            TimeField.SUBTYPE_TIME        -> ClassName("java.time", "LocalTime")
            // A map's @valueType:timestamp follows the field.timestamp DEFAULT — an
            // absolute instant (ADR-0036 Wave 2). @localTime has no place on a map value.
            TimestampField.SUBTYPE_TIMESTAMP -> ClassName("java.time", "Instant")
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
        exposedColumnSpec(field, KotlinGenUtil.resolveColumnName(field))

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
        // Default for field.timestamp (ADR-0036 Wave 2) emits the file-local
        // `instantWithTimeZone(...)` extension — a `Column<java.time.Instant>` with
        // `TIMESTAMP WITH TIME ZONE` DDL (see [EXPOSED_INSTANT_TZ_FN]). That helper is
        // emitted into the table's own file by [KotlinExposedTableGenerator], so it needs
        // NO external import — return null for the default branch. The rare `@localTime:true`
        // naive opt-out emits `datetime(...)` — Postgres `timestamp without time zone`,
        // mapped by exposed-java-time to `java.time.LocalDateTime` (the zone-less wall-clock
        // shape) — which needs the javatime `datetime` import.
        is TimestampField -> {
            if (localTimeOptIn(field)) "org.jetbrains.exposed.sql.javatime.datetime"
            else null
        }
        // `@dbColumnType=jsonb` on a field.string emits the `jsonb(...)` extension, which
        // needs the exposed-json import. `@dbColumnType=uuid` maps to `uuid(...)`, a Table
        // member — no import. All other StringField shapes (varchar/text) are Table members.
        // A derived `isArray` string emits Exposed's `array<E>("col")` — a Table MEMBER
        // (like uuid/integer), so no import is required (same as the uuid/text paths).
        is StringField    ->
            if (!isArrayResolved(field) && dbColumnType(field) == DB_COLUMN_TYPE_JSONB) EXPOSED_JSONB_IMPORT else null
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
            // Phase 1 (dbColumnType slim-and-derive): a `field.string` + `isArray` DERIVES a
            // native Postgres `text[]` via Exposed's `array<E>("col", columnType)` Table member.
            // The element ColumnType is explicit (TextColumnType) so emission never depends on
            // Exposed's reified resolveColumnType picking VARCHAR vs TEXT for String — `text[]`
            // matches the canonical migrate-ts DDL. Derivation wins over any `@dbColumnType`.
            //
            // `@dbColumnType=uuid` opt-in: emit `uuid("col")` instead of `text`. The Kotlin
            // data class property stays `String` for now (Exposed coerces String ↔ uuid at
            // the SQL boundary), so adopters can convert a string-shaped FK column to the
            // native Postgres uuid type without changing their data class shape.
            //
            // `@dbColumnType=jsonb` opt-in: emit a real Postgres `JSONB` column via the
            // Exposed `jsonb(name, encoder, decoder)` extension with identity String
            // functions (the property stays raw-JSON `String`; the JSON text passes
            // straight through). Matches the other ports' JSONB emission — a TEXT column
            // would never round-trip to JSONB through the introspection corpus.
            if (isArrayResolved(field)) {
                "array<String>(\"$colName\", org.jetbrains.exposed.sql.TextColumnType())"
            } else when (dbColumnType(field)) {
                DB_COLUMN_TYPE_UUID  -> "uuid(\"$colName\")"
                // `@dbColumnType=jsonb` open bag (#98): decode the JSONB text to a kotlinx
                // `JsonElement` (so the data-class property + CRUD DTO is a parsed JSON value, not
                // a double-encoded String) and encode it back via `toString()` (a JsonElement's
                // toString is canonical JSON). `Json.parseToJsonElement` returns a concrete
                // `JsonElement`, which ANCHORS the Exposed column's generic to `Column<JsonElement>`
                // (the `{ it }` identity codec would have left it `Column<String>`). The table file
                // imports `kotlinx.serialization.json.Json` (see KotlinExposedTableGenerator).
                DB_COLUMN_TYPE_JSONB -> "jsonb(\"$colName\", { it.toString() }, { Json.parseToJsonElement(it) })"
                else -> {
                    // Dispatch to Exposed `text(name)` when the field is unbounded text:
                    //   (1) no `@maxLength` declared — the DEFAULT for `field.string` (Phase 1:
                    //       no-maxLength string → `text`, matching the canonical TS Postgres DDL), OR
                    //   (2) `@maxLength` exceeds the VARCHAR/TEXT cutoff (Postgres TOAST boundary).
                    // Otherwise (a `@maxLength` within the cutoff) emit `varchar(name, N)`.
                    val maxLen = stringMaxLengthOrNull(field)
                    if (maxLen == null || maxLen > VARCHAR_TEXT_THRESHOLD) "text(\"$colName\")"
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
        // Default for field.timestamp is TZ-aware (`java.time.Instant`) — ADR-0036 Wave 2:
        // emits the file-local `instantWithTimeZone(...)` extension, a
        // `Column<java.time.Instant>` (matches the Instant data class) whose DDL is
        // `TIMESTAMP WITH TIME ZONE` (see [EXPOSED_INSTANT_TZ_FN]). The rare `@localTime:true`
        // naive opt-out emits `datetime(...)` — Postgres `timestamp without time zone`
        // (`java.time.LocalDateTime`), the zone-less wall-clock shape.
        is TimestampField -> {
            if (localTimeOptIn(field)) "datetime(\"$colName\")"
            else "$EXPOSED_INSTANT_TZ_FN(\"$colName\")"
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
        // Phase 1: with `isArray` it DERIVES a native Postgres `uuid[]` via Exposed's
        // `array<E>("col", columnType)` Table member (explicit UUIDColumnType element) —
        // matching the canonical migrate-ts DDL.
        is UuidField      ->
            if (isArrayResolved(field)) "array<java.util.UUID>(\"$colName\", org.jetbrains.exposed.sql.UUIDColumnType())"
            else "uuid(\"$colName\")"
        // field.uri → file-local `uriColumn(...)` extension: a `Column<java.net.URI>` whose
        // DDL is plain `text` (Postgres has no uri type). The helper lives in the package-shared
        // MetaInetUriColumnType.kt support file (emitted once per package).
        // #234: a @lenient field.uri is a plain `text` column (no uriColumn / Column<URI>).
        is UriField       -> if (lenientNetField(field)) "text(\"$colName\")" else "$EXPOSED_URI_FN(\"$colName\")"
        // field.inet → file-local `inetColumn(...)` extension: a `Column<java.net.InetAddress>`
        // whose DDL is the Postgres-native `inet`. The helper lives in the package-shared
        // MetaInetUriColumnType.kt support file (emitted once per package). #234: a @lenient
        // field.inet is a plain `text` column (the native inet column would reject a
        // not-strictly-valid value at INSERT).
        is InetField      -> if (lenientNetField(field)) "text(\"$colName\")" else "$EXPOSED_INET_FN(\"$colName\")"
        // field.map → a single Postgres `JSONB` column holding the JSON object. Same emission
        // as a `field.object` jsonb column (the typed-object JSONB path) — the Exposed
        // `jsonb(name, encoder, decoder)` extension encoded/decoded through the shared Jackson
        // `metaJsonbMapper` (NOT kotlinx — the generated data classes are plain, no compiler
        // plugin). Never flattened; isArray does not apply to a map. The value type V decodes
        // via a Jackson `TypeReference<Map<String, V>>`; this loader-free arm can only name the
        // scalar `@valueType` (an `@objectRef` map falls back to `Any`) — the loader-aware
        // KotlinExposedTableGenerator.buildObjectColumns is where a typed VO map is emitted, and
        // is the normal producer of map columns; this arm keeps the mapper total for direct callers.
        is MapField       -> {
            val valueType = mapValueScalarTypeName(field)?.toString() ?: "Any"
            "jsonb(\"$colName\", { metaJsonbMapper.writeValueAsString(it) }, " +
                "{ metaJsonbMapper.readValue(it, object : com.fasterxml.jackson.core.type.TypeReference<Map<String, $valueType>>() {}) })"
        }
        else -> throw IllegalArgumentException(
            "unsupported Exposed column mapping for ${field::class.simpleName} '${field.name}'"
        )
    }

    /**
     * Read the `@dbColumnType` attribute (case-folded) for column-type overrides. Resolved
     * THROUGH the `extends` super-field chain (`includeParent = true`), so an `object.projection`
     * field that binds a base-entity column via `extends:` inherits that column's physical type
     * (uuid / jsonb) — exactly as it already inherits `@maxLength` (see
     * [stringMaxLengthOrNull]) and `isArray` (see [isArrayResolved]). Own value still wins
     * (checked first by [MetaData.hasMetaAttr]). Returns null when absent. See
     * [ATTR_DB_COLUMN_TYPE] for recognised values.
     */
    private fun dbColumnType(field: MetaField<*>): String? =
        stringAttr(field, ATTR_DB_COLUMN_TYPE, includeParent = true)?.lowercase()

    /**
     * True iff [field] is an array — own `isArray` flag/attr OR (for an `object.projection`
     * field that binds an array base field via `extends:`) the inherited `isArray` from the
     * super-field chain. Phase 1 derives native Postgres `text[]` / `uuid[]` from this, so
     * resolving it THROUGH `extends` keeps the projection-inheritance contract intact — a
     * projection field inherits its base field's array-ness the same way it inherits
     * `@maxLength` and `@dbColumnType` (own-flag wins; checked first by [MetaField.isArrayType]).
     */
    private fun isArrayResolved(field: MetaField<*>): Boolean {
        if (field.isArrayType()) return true
        // Walk the `extends` super-field chain (defensive against cycles via a visited set).
        var current: MetaField<*>? = field.superField
        val seen = HashSet<String>()
        while (current != null) {
            if (!seen.add(current.name)) break
            if (current.isArrayType()) return true
            current = current.superField
        }
        return false
    }

    /**
     * True iff [field] carries `@localTime=true` (ADR-0036 Wave 2) — the naive wall-clock
     * opt-out. Absent/false (the default) = an absolute instant. Resolved THROUGH the
     * `extends` chain (so a projection field inherits the base column's tz/naive shape).
     * Centralised so the type spec and the import set stay in lockstep — both call this.
     */
    private fun localTimeOptIn(field: MetaField<*>): Boolean =
        booleanAttr(field, ATTR_LOCAL_TIME)

    /**
     * #234 — true iff [field] is a `field.uri` / `field.inet` carrying `@lenient=true` (the opt-out of
     * strict well-formedness). A lenient uri/inet degrades to a plain `String` property + a plain `text`
     * column (no native java.net.URI / InetAddress type, no wire deserializer). ADR-0039: resolving read
     * ([booleanAttr] passes includeParent=true) so an abstract `field.uri @lenient` inherited via
     * `extends` degrades the concrete field too. Public so [KotlinEntityGenerator] shares the SSOT.
     */
    fun lenientNetField(field: MetaField<*>): Boolean =
        (field is UriField || field is InetField) && booleanAttr(field, UriField.ATTR_LENIENT)

    /**
     * True iff [field] is a [TimestampField] using the instant/TZ-aware column — i.e. the
     * DEFAULT (ADR-0036 Wave 2): every `field.timestamp` NOT flagged `@localTime:true`.
     * [KotlinExposedTableGenerator] uses this to decide whether a table file must carry the
     * file-local `instantWithTimeZone(...)` support helper (the custom
     * `Column<java.time.Instant>` / `TIMESTAMP WITH TIME ZONE` column type). Non-timestamp
     * fields are always false.
     */
    fun usesInstantWithTimeZone(field: MetaField<*>): Boolean =
        field is TimestampField && !localTimeOptIn(field)

    /**
     * True iff [field] needs the package-shared `MetaInetUriColumnType.kt` support file —
     * i.e. it is a [UriField] (custom `Column<URI>` over `text`) or an [InetField] (custom
     * `Column<InetAddress>` over the Postgres-native `inet` type). ADR-0036/0037 Wave 3.
     * [KotlinExposedTableGenerator] uses this to decide whether a package needs the support
     * file (one `uriColumn`/`inetColumn` extension declaration shared across its tables).
     */
    fun usesInetUriHelper(field: MetaField<*>): Boolean =
        (field is UriField || field is InetField) && !lenientNetField(field)

    /**
     * Best-effort read of a named boolean attribute on [field], resolved THROUGH the `extends`
     * super-field chain (own value wins). Returns false when absent/unparseable. Used for the
     * `@localTime` naive-timestamp opt-out.
     */
    private fun booleanAttr(field: MetaField<*>, name: String): Boolean {
        if (!field.hasMetaAttr(name, true)) return false
        val raw = runCatching { field.getMetaAttr(name, true).value }.getOrNull() ?: return false
        return raw.toString().trim().toBoolean()
    }

    /**
     * Best-effort read of a named string attribute on [field] (own-only by default;
     * [includeParent] = true also walks the `extends` super-field chain). Returns null when
     * the attribute is absent, throws during lookup, or isn't a [com.metaobjects.attr.MetaAttribute].
     * Used for non-typed dispatch keys (e.g. `@dbColumnType`, `@valueType`) read off a field.
     * ADR-0039: [includeParent] defaults to true (resolving is the default); pass false only
     * for the rare own-only case.
     */
    private fun stringAttr(field: MetaField<*>, name: String, includeParent: Boolean = true): String? {
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

    /**
     * Best-effort read of a named int-valued attribute on [field], resolved THROUGH the
     * `extends` super-field chain (own value wins); null when absent/unparseable. ADR-0039:
     * `@precision`/`@scale` are effective properties — a concrete field extending an abstract
     * decimal must inherit them (consistent with [stringMaxLengthOrNull] which resolves).
     */
    private fun intAttr(field: MetaField<*>, name: String): Int? {
        if (!field.hasMetaAttr(name, true)) return null
        val raw = runCatching { field.getMetaAttr(name, true).value }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull()
            else -> null
        }
    }

    /**
     * Resolve `@maxLength` on a StringField (resolved THROUGH the `extends` chain), or `null`
     * when none is declared. Phase 1: a no-`@maxLength` string is unbounded text and derives to
     * Exposed `text(name)` (matching the canonical TS Postgres `text` DDL) — there is no longer a
     * `varchar(255)` default. Returns null both when the attr is absent and when it is present but
     * unparseable.
     */
    private fun stringMaxLengthOrNull(field: StringField): Int? {
        if (!field.hasMetaAttr(StringField.ATTR_MAX_LENGTH, true)) return null
        val raw = runCatching {
            field.getMetaAttr(StringField.ATTR_MAX_LENGTH, true).value
        }.getOrNull()
        return when (raw) {
            is Number -> raw.toInt()
            is String -> raw.toIntOrNull()
            else -> null
        }
    }

    /**
     * The `now()` expression for [field]'s temporal COLUMN type (issue #203 / ADR-0045) — keyed
     * off the column type so it generalizes across every temporal subtype: `field.timestamp`
     * (default) → `java.time.Instant.now()`, `@localTime` → `java.time.LocalDateTime.now()`,
     * `field.date` → `java.time.LocalDate.now()`, `field.time` → `java.time.LocalTime.now()`. Each
     * of those `java.time` types exposes a static `now()`. Fully-qualified so no import bookkeeping
     * is needed (the four types would otherwise collide on simple names across generated files).
     */
    fun nowExpr(field: MetaField<*>): String {
        val tn = kotlinTypeName(field)
        val fqn = (tn as? ClassName)?.canonicalName ?: tn.toString()
        return "$fqn.now()"
    }
}
