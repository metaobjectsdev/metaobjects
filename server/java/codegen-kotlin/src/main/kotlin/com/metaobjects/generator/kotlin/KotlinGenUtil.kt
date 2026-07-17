package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.field.DateField
import com.metaobjects.field.MetaField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.origin.AggregateOrigin
import com.metaobjects.origin.MetaOrigin
import com.metaobjects.source.RdbSource

/**
 * Helpers shared by the codegen-kotlin generators. Extracted to keep
 * the three generators (entity / exposed-table / payload) from carrying near-identical
 * private copies of the same lookups.
 *
 * `public` (was `internal`) so that adopters subclassing a generator — e.g. overriding
 * [KotlinExposedTableGenerator.buildObjectColumns] in another module — can reuse these
 * lookups instead of re-implementing them (the sibling `KotlinNaming` / `KotlinTypeMapper` /
 * `PackageMapping` helper objects are already public for the same reason).
 */
public object KotlinGenUtil {

    /**
     * `@autoSet` policy values — mirror the TS `AUTO_SET_ON_CREATE` / `AUTO_SET_ON_UPDATE`
     * (`field-constants.ts`). The Java `metadata` module registers the attr name
     * ([MetaField.ATTR_AUTO_SET]) but carries no value constants, so codegen-kotlin declares
     * them here (issue #203). A `field.timestamp @autoSet: onCreate` is stamped by the CRUD
     * layer at insert; `onUpdate` is stamped at every write.
     */
    const val AUTO_SET_ON_CREATE = "onCreate"
    const val AUTO_SET_ON_UPDATE = "onUpdate"

    /**
     * Resolve a MetaObject (entity OR value) by exact FQN match or by short-name match
     * (the trailing segment after the last `::`). Returns null when neither matches.
     */
    fun resolveObjectByShortOrFqn(loader: MetaDataLoader, ref: String): MetaObject? {
        for (child in loader.metaObjects) {
            if (child.name == ref || child.name.substringAfterLast("::") == ref) return child
        }
        return null
    }

    /**
     * The first `source.rdb` child of [obj], RESOLVED through the `extends` super chain
     * (ADR-0039). `MetaObject.getSources(true)` walks the inheritance chain, so an entity
     * that inherits its `source.rdb` from a base entity still resolves a source — a raw
     * `obj.children.filterIsInstance<RdbSource>()` read returned null for such entities and
     * the generators emitted NOTHING for them (the high-blast-radius own-accessor bug).
     * Returns null when neither the object nor any ancestor declares an `source.rdb`.
     */
    fun firstRdbSource(obj: MetaObject): RdbSource? =
        obj.getSources(true).filterIsInstance<RdbSource>().firstOrNull()

    /**
     * True iff [obj] (or any ancestor via `extends`) declares a `source.rdb` — i.e. it is
     * persisted. Resolving (ADR-0039). See [firstRdbSource].
     */
    fun hasRdbSource(obj: MetaObject): Boolean = firstRdbSource(obj) != null

    /**
     * The OWN writable-kind `source.rdb` of [obj] (a `@kind: table`) — the WRITE target of a
     * write-through entity read-view (FR-024 §7, #214). Own-only + role-agnostic:
     * `getSources(false)` reads only this object's declared sources, and partitioning on
     * `isWritable` is declaration-order-independent (unlike [firstRdbSource], which returns the
     * FIRST-declared source and so can't safely pick table-vs-view for a two-source entity).
     * NOTE: a replica view carries `@role: replica`, so the role-scoped
     * `MetaObject.findPrimaryReadOnlySource()` cannot be used to find its counterpart — hence
     * these role-agnostic selectors. Null when [obj] declares no own writable rdb source.
     */
    fun writableRdbSource(obj: MetaObject): RdbSource? =
        obj.getSources(false).filterIsInstance<RdbSource>().firstOrNull { it.isWritable }

    /**
     * The OWN read-only-kind `source.rdb` of [obj] (a `@kind: view` / materializedView / …) —
     * the READ target of a write-through entity read-view (FR-024 §7, #214). Own-only +
     * role-agnostic (see [writableRdbSource]); use the source's [RdbSource.getPhysicalName]
     * for its physical view name (a `@role: replica @kind: view` source returns its `@view`
     * alias). Null when [obj] declares no own read-only rdb source.
     */
    fun readOnlyRdbSource(obj: MetaObject): RdbSource? =
        obj.getSources(false).filterIsInstance<RdbSource>().firstOrNull { it.isReadOnly }

    /**
     * True iff [field] is DERIVED — it carries an `origin.*` child (its value is computed from a
     * read source, not stored on the writable table). Delegates to the shared
     * [MetaField.isDerived] predicate (own-only; `origin.*` never inherits — ADR-0029/0039).
     * A derived field is EXCLUDED from the write table + create/patch inputs and carried only on
     * the read (view) shape (#214). Thin wrapper so the generators read one named predicate.
     */
    fun isDerivedField(field: MetaField<*>): Boolean = field.isDerived

    /**
     * Split `"A.b"` into `("A","b")`; null if the ref isn't a single-dot ref
     * (no dot, leading dot, or trailing dot).
     */
    fun splitDottedRef(ref: String): Pair<String, String>? {
        val dot = ref.indexOf('.')
        if (dot <= 0 || dot >= ref.length - 1) return null
        return ref.substring(0, dot) to ref.substring(dot + 1)
    }

    /**
     * True if [obj] has an own `@isAbstract` attribute set to boolean-true. ADR-0039:
     * `@isAbstract` is a declaration-layer marker — it describes THIS declaration and must
     * NOT be inherited (a concrete subtype extending an abstract base is itself concrete
     * and MUST emit). KEPT own-only, matching the ValidationPhase / GeneratorUtil.isAbstract
     * convention. Shared by every instance/write generator so the "never emit write
     * artifacts for an abstract entity" invariant has a single definition.
     */
    fun isAbstractEntity(obj: MetaObject): Boolean {
        if (!obj.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)) return false
        val v = runCatching { obj.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).value }.getOrNull()
        return when (v) {
            is Boolean -> v
            is String -> v.equals("true", ignoreCase = true)
            else -> false
        }
    }

    /**
     * Required iff explicit `@required: true` attribute is set on the field (inheritance
     * allowed); otherwise nullable. MVP heuristic — refined when richer required-detection
     * lands (see fr-003 spec).
     */
    fun isRequiredField(field: MetaField<*>): Boolean {
        if (!field.hasMetaAttr(MetaField.ATTR_REQUIRED, true)) return false
        val raw = runCatching { field.getMetaAttr(MetaField.ATTR_REQUIRED, true).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> raw.equals("true", ignoreCase = true)
            else -> false
        }
    }

    /**
     * The `@autoSet` policy of [field] — [AUTO_SET_ON_CREATE] / [AUTO_SET_ON_UPDATE] — or null
     * when the field is not auto-set (issue #203). Read RESOLVING (ADR-0039, `includeParentData
     * = true`): `@autoSet` is idiomatically declared once on a shared base entity's
     * `createdAt`/`updatedAt` and inherited by every concrete entity via `extends`, so a field
     * that inherits the marker must still be stamped. Only the two recognized policy strings are
     * returned; any other value is treated as absent.
     */
    fun autoSetPolicy(field: MetaField<*>): String? {
        if (!field.hasMetaAttr(MetaField.ATTR_AUTO_SET, true)) return null
        val raw = runCatching { field.getMetaAttr(MetaField.ATTR_AUTO_SET, true).value }.getOrNull()
        return when (raw) {
            AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE -> raw as String
            else -> null
        }
    }

    /**
     * True iff [field] is a temporal subtype (`field.date` / `field.time` / `field.timestamp`) —
     * the only subtypes `@autoSet` stamping applies to. The registry constrains `@autoSet` to
     * these subtypes; this guard keeps the generated `now()` well-typed (every temporal Kotlin
     * type — `Instant`/`LocalDate`/`LocalTime`/`LocalDateTime` — has a static `now()`), so a
     * stray `@autoSet` on a non-temporal field is ignored rather than emitting non-compiling code.
     */
    fun isTemporalField(field: MetaField<*>): Boolean =
        field is DateField || field is TimeField || field is TimestampField

    /**
     * True iff [field] should be CRUD-stamped: it carries a recognized [autoSetPolicy] AND is a
     * [temporal][isTemporalField] subtype. The single predicate the repository generator branches
     * on so the "which columns does the CRUD layer own" decision has one definition (issue #203).
     */
    fun isAutoSetField(field: MetaField<*>): Boolean =
        isTemporalField(field) && autoSetPolicy(field) != null

    /**
     * #195 — true iff [field]'s value is derived by an `origin.aggregate` whose `@agg` is one of
     * the COALESCE-guaranteed-non-null reducers: `any`/`all` (a boolean quantifier, empty set →
     * `false`/`true` — never null) or `collect` (an array rollup, empty set → `[]` — never null).
     * A projection/read-model field so derived is non-null in the synthesized view EVEN WHEN it is
     * not `@required`, so its generated Kotlin type (data-class property AND Exposed view column)
     * must be non-null — the analog of the TypeScript `originGuaranteedNonNull` predicate that joins
     * `isRequired()` in the column mapper's not-null decision. `origin.first` (empty related set →
     * null) and `origin.computed` (expression-dependent) are deliberately NOT here — they keep the
     * conservative nullable default.
     *
     * ADR-0039/ADR-0029: `origin.*` never inherits, so this reads the field's OWN children
     * (`field.children`) — matching [KotlinPayloadGenerator]'s origin dispatch.
     */
    fun originGuaranteedNonNull(field: MetaField<*>): Boolean {
        val origin = field.children.filterIsInstance<AggregateOrigin>().firstOrNull() ?: return false
        return origin.agg == MetaOrigin.AGG_ANY ||
            origin.agg == MetaOrigin.AGG_ALL ||
            origin.agg == MetaOrigin.AGG_COLLECT
    }

    /**
     * Convert a camelCase identifier to snake_case for use as a physical SQL column name.
     *
     * Used by [KotlinExposedTableGenerator] so the column-name string argument matches the
     * snake_case convention nearly every Postgres schema uses, while the Kotlin property name
     * stays camelCase (Kotlin convention). Examples:
     * ```
     * camelToSnake("displayName") == "display_name"
     * camelToSnake("htmlContent") == "html_content"
     * camelToSnake("id")          == "id"
     * camelToSnake("userId")      == "user_id"
     * camelToSnake("URLPath")     == "url_path"   // leading run of caps treated as one word
     * ```
     *
     * The algorithm inserts `_` before any uppercase letter that is preceded by either a
     * lowercase letter OR by another uppercase letter immediately followed by a lowercase
     * letter (the second rule splits "URLPath" into "url_path" rather than "u_r_l_path").
     * The whole result is then lowercased. Non-ASCII letters are passed through unchanged.
     */
    fun camelToSnake(name: String): String {
        if (name.isEmpty()) return name
        val sb = StringBuilder(name.length + 4)
        for (i in name.indices) {
            val c = name[i]
            if (i > 0 && c.isUpperCase()) {
                val prev = name[i - 1]
                val next = if (i + 1 < name.length) name[i + 1] else null
                // Insert underscore between [lower|digit][Upper] (standard camelCase boundary)
                // OR between [Upper][Upper][lower] (acronym → word boundary, e.g. URLPath → URL_Path)
                if (prev.isLowerCase() || prev.isDigit() ||
                    (prev.isUpperCase() && next != null && next.isLowerCase())) {
                    sb.append('_')
                }
            }
            sb.append(c.lowercaseChar())
        }
        return sb.toString()
    }
}
