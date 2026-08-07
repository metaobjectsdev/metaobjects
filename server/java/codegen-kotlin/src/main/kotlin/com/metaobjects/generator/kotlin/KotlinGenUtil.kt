package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.field.DateField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.origin.AggregateOrigin
import com.metaobjects.origin.MetaOrigin
import com.metaobjects.source.RdbSource
import com.metaobjects.template.MetaTemplate
import com.metaobjects.validation.SymbolTable

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

    // =========================================================================
    // ADR-0042 — canonical package-local object-ref resolution (@payloadRef).
    //
    // The loader validates a template's @payloadRef via the SAME package-local
    // contract (ValidationPhase.resolveRootObject, backed by SymbolTable): an FQN ref
    // binds EXACTLY; a bare ref binds the referrer's own package, else a root-level
    // object; NO cross-package bare-name / bare-tail fallback. Reusing the loader's own
    // public [SymbolTable] (rather than a divergent codegen copy) keeps codegen's
    // @payloadRef resolution identical to the loader's, so under a cross-package
    // short-name collision codegen binds the SAME value-object the loader validated —
    // never a load-order-dependent decoy (the #244 class). The bare-tail/first-match
    // [resolveObjectByShortOrFqn] above is deliberately left as-is: it backs the
    // @from/@of/@via dotted-ref navigation (a different ref kind, #244's own domain).
    // =========================================================================

    /**
     * Resolve a metadata OBJECT reference (bare or FQN) under the loader's ADR-0042
     * package-local contract, or null. [referrerPkg] is the effective package of the node
     * carrying the ref (a template's own `getPackage()` for a @payloadRef); "" for root-level.
     */
    fun resolveObjectRef(loader: MetaDataLoader, ref: String?, referrerPkg: String?): MetaObject? {
        if (ref == null) return null
        return SymbolTable.build(loader.root).resolveObject(ref, referrerPkg ?: "")
    }

    /**
     * Resolve [ref] to its `object.value` target under the same ADR-0042 package-local
     * contract as [resolveObjectRef] (rejects entities — a @payloadRef must be a VO).
     */
    fun resolveValueObjectRef(loader: MetaDataLoader, ref: String?, referrerPkg: String?): MetaObject? =
        resolveObjectRef(loader, ref, referrerPkg)?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }

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

    // =========================================================================
    // ADR-0044 — collision-scoped payload / extracted-mirror naming.
    //
    // Lifted here (was private on [KotlinPayloadGenerator]) so the strict payload
    // record, the `...Extracted` mirror family, and the extractor all share ONE
    // name-map algorithm. Kotlin `protected` is NOT same-package-visible, so the
    // extract-tier emitters ([KotlinExtractSchemaEmitter] / [KotlinExtractMapperEmitter] /
    // [KotlinExtractorGenerator], all in this package) reach these public helpers here.
    // =========================================================================

    /**
     * ADR-0044 — the run's nested-PAYLOAD name map (VO FQN -> `<Short>Payload`, or the
     * package-qualified `AcmeAlphaNotePayload` on a same-output-package short-name collision).
     * See [computeNameMap]. Consumed by [KotlinPayloadGenerator] (the strict record files) and
     * the extractor's `toStrict<Name>` / mapper-return references.
     */
    fun computePayloadNameMap(templates: List<MetaTemplate>, loader: MetaDataLoader): Map<String, String> =
        computeNameMap(templates, loader) { KotlinNaming.payloadName(it) }

    /**
     * ADR-0044 — the run's nested-EXTRACTED-mirror name map (VO FQN -> `<Short>Extracted`, or the
     * package-qualified `AcmeAlphaNoteExtracted` on a collision). Uses the SAME [computeNameMap]
     * closure + collision grouping as [computePayloadNameMap] (differing only in the leaf suffix),
     * so the `...Extracted` mirror and the `...Payload` strict record qualify in lockstep.
     */
    fun computeExtractedNameMap(templates: List<MetaTemplate>, loader: MetaDataLoader): Map<String, String> =
        computeNameMap(templates, loader) { KotlinNaming.extractedName(it) }

    /**
     * ADR-0044 pass 1/2 — the run's nested-class name map, keyed by value-object FQN
     * (`MetaObject.name`), scoped per OUTPUT PACKAGE. Kotlin is a one-class-per-file emitter,
     * so its collision domain is the output prompts package: two value-objects sharing a bare
     * short name written into the same package would clobber one `NotePayload.kt` /
     * `NoteExtracted` declaration. A nested VO whose bare short name is UNIQUE in its output
     * package is named `nameOf(<Short>)` (byte-identical to pre-ADR-0044 output); a COLLISION
     * names every member `nameOf(<PkgQualified><Short>)` (`acme::alpha::Note` -> `AcmeAlphaNote...`).
     * A still-colliding derived name fails loud with [KotlinPayloadGenerator.ERR_PAYLOAD_NAME_COLLISION].
     * Pure function of the templates — never of emission order.
     */
    private fun computeNameMap(
        templates: List<MetaTemplate>,
        loader: MetaDataLoader,
        nameOf: (String) -> String,
    ): Map<String, String> {
        // FQN -> output package (first reaching template in caller-sorted order wins, matching
        // the run-wide dedupe). The primary VO is template-named, so excluded.
        val voOutPkg = LinkedHashMap<String, String>()
        val orderedFqns = ArrayList<String>()
        for (tmpl in templates) {
            val payloadRef = tmpl.payloadRef ?: continue
            // ADR-0042 — resolve @payloadRef under the loader's own package-local contract.
            val vo = resolveValueObjectRef(loader, payloadRef, tmpl.getPackage()) ?: continue
            val nestedPkg = KotlinNaming.promptsPackage(PackageMapping.splitFqn(tmpl.name).first)
            collectNestedClosure(vo, nestedPkg, voOutPkg, orderedFqns, mutableSetOf(vo.name))
        }
        // Group by (output package, bare short name).
        val byPkgShort = LinkedHashMap<String, MutableList<String>>()
        for (fqn in orderedFqns) {
            val key = voOutPkg[fqn] + " " + PackageMapping.splitFqn(fqn).second
            byPkgShort.getOrPut(key) { ArrayList() }.add(fqn)
        }
        val nameMap = LinkedHashMap<String, String>()
        for (fqns in byPkgShort.values) {
            if (fqns.size == 1) {
                val fqn = fqns[0]
                nameMap[fqn] = nameOf(PackageMapping.splitFqn(fqn).second)
            } else {
                for (fqn in fqns) {
                    val (pkg, short) = PackageMapping.splitFqn(fqn)
                    nameMap[fqn] = nameOf(packageQualifiedName(pkg, short))
                }
            }
        }
        // Backstop — per output package, two DISTINCT FQNs deriving the same class name.
        // Sorted so the named pair (and whether any collision fires) is order-independent.
        val ownerByPkgName = HashMap<String, String>()
        for (fqn in nameMap.keys.sorted()) {
            val pkgName = voOutPkg[fqn] + " " + nameMap[fqn]
            val prev = ownerByPkgName.putIfAbsent(pkgName, fqn)
            if (prev != null && prev != fqn) {
                throw GeneratorException(
                    "${KotlinPayloadGenerator.ERR_PAYLOAD_NAME_COLLISION}: payload record name collision: \"${nameMap[fqn]}\" " +
                        "derives from both \"$prev\" and \"$fqn\" — rename one value-object or move " +
                        "it to a package that derives a distinct name"
                )
            }
        }
        return nameMap
    }

    /**
     * ADR-0044 pass 1 — walk [vo]'s transitive nested-payload closure (declared
     * `field.object @objectRef` edges ONLY, #270), assigning each not-yet-seen target VO
     * to [outPkg] (first reaching template wins) and recording it in [orderedFqns].
     * [seen] is seeded with the primary VO's FQN and is the cycle guard.
     */
    private fun collectNestedClosure(
        vo: MetaObject,
        outPkg: String,
        voOutPkg: MutableMap<String, String>,
        orderedFqns: MutableList<String>,
        seen: MutableSet<String>,
    ) {
        for (field in vo.metaFields) {
            val target = nestedTargetOf(field) ?: continue
            val fqn = target.name
            if (!seen.add(fqn)) continue
            if (!voOutPkg.containsKey(fqn)) {
                voOutPkg[fqn] = outPkg
                orderedFqns.add(fqn)
            }
            collectNestedClosure(target, outPkg, voOutPkg, orderedFqns, seen)
        }
    }

    /**
     * The nested-payload target VO a [field] contributes to the closure, or `null` when it
     * contributes no nested class. The ONLY closure edge is a declared
     * `field.object @objectRef` whose target is an `object.value` (#270 — an `origin.*`
     * child never contributes an edge; a non-object field contributes nothing). NOTE: the
     * `field.objectRef` navigation uses the loader-bound `objectRef` — the field-navigation
     * ref kind (#244's domain), intentionally NOT the ADR-0042 @payloadRef resolver (which
     * is only for the template's own @payloadRef).
     */
    private fun nestedTargetOf(field: MetaField<*>): MetaObject? {
        if (field is ObjectField) {
            val target = try { field.objectRef } catch (e: RuntimeException) { null } ?: return null
            if (target.subType != MetaObject.SUBTYPE_VALUE) return null
            return target
        }
        return null
    }

    /**
     * ADR-0044 — PascalCase each dotted segment of [kotlinPkg] (already `::`->`.`
     * converted by [PackageMapping.splitFqn]), concatenate, append the bare [shortName]
     * (`"acme.alpha"` + `"Note"` -> `"AcmeAlphaNote"`). A root-level (empty-package) node
     * keeps its bare short name.
     */
    fun packageQualifiedName(kotlinPkg: String, shortName: String): String {
        if (kotlinPkg.isEmpty()) return shortName
        return kotlinPkg.split(".")
            .filter { it.isNotEmpty() }
            .joinToString("") { it.replaceFirstChar { c -> c.uppercaseChar() } } + shortName
    }
}
