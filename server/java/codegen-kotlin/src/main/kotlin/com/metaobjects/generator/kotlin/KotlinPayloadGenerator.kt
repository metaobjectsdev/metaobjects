package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.origin.AggregateOrigin
import com.metaobjects.origin.CollectionOrigin
import com.metaobjects.origin.ComputedOrigin
import com.metaobjects.origin.FirstOrigin
import com.metaobjects.origin.MetaOrigin
import com.metaobjects.origin.PassthroughOrigin
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.template.MetaTemplate
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one @Serializable payload data class per template.*, derived from its
 * @payloadRef view-object's field tree.
 *
 * <p>Output package = `<entity-package>.prompts`; class name = `<TemplateShortName>Payload`.
 *
 * <p>Origin-aware: each field on the payload VO may carry an `origin.*` child that
 * declares how the value is derived. The property's TypeName is resolved as:
 * <ul>
 *   <li>{@code origin.passthrough} (@from "Entity.field") — type of the referenced source field.</li>
 *   <li>{@code origin.aggregate}  (@agg count) — {@code Long}; (@agg avg) — {@code Double};
 *       (@agg sum/min/max) — type of the referenced `@of` field; (@agg any/all) — {@code Boolean}
 *       (a predicate quantifier, #195); (@agg collect) — {@code List<T>} where T is the `@of`
 *       element type (an array rollup, #195).</li>
 *   <li>{@code origin.collection} (@via "Parent.rel") — {@code List<TargetPayload>}, and the
 *       nested payload class is recursively emitted alongside (deduped per execute() run).</li>
 *   <li>{@code origin.computed} (@expr ...) — the field's own declared subType, NULLABLE
 *       (expression nullability is conservative, #195).</li>
 *   <li>{@code origin.first} (@of "Entity.field" @orderBy [...]) — the `@of` source column's type,
 *       NULLABLE (an empty related set → null, #195).</li>
 *   <li>No origin child — fall back to {@link KotlinTypeMapper#payloadTypeName(MetaField)}
 *       (parsed JSON value for a `field.string @dbColumnType=jsonb` open bag; otherwise the
 *       same mapping as {@code kotlinTypeName}).</li>
 * </ul>
 */
open class KotlinPayloadGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    companion object {
        // ADR-0044 backstop error code — a codegen-time (not loader) error, peer of the
        // render tier's ERR_VAR_NOT_ON_PAYLOAD. Declared LOCALLY (as in the TS/C#/Python/
        // Java ports) rather than in the shared cross-port ledger; promoted to the ledger
        // once the coordinated follow-up lands, so no port reddens on a code it doesn't emit.
        const val ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION"
    }

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        // Dedupe nested payload classes emitted via origin.collection across all
        // templates in this run. Key = FQN of the source view-object (or entity) the
        // nested payload was generated from.
        val emittedNestedFqns = mutableSetOf<String>()
        // Run-level dedupe of emitted enum-class files by enum FQN. A `field.enum` payload field is
        // typed as its generated enum class (reusing the entity enum scheme); two fields sharing an
        // abstract enum super collapse onto ONE emitted file.
        val emittedEnumFqns = mutableSetOf<String>()
        // ADR-0039: root-scan discipline — resolving children accessor.
        val templates = loader.root.getChildren(MetaTemplate::class.java, true)
            .sortedBy { it.name }
        // ADR-0044 — collision-scoped nested-payload class names, a pure function of the
        // loaded templates (order-independent). Keyed by VO FQN.
        val nameMap = computePayloadNameMap(templates, loader)
        for (md in templates) {
            emit(md, loader, outRoot, emittedNestedFqns, emittedEnumFqns, nameMap)
        }
    }

    /**
     * ADR-0044 pass 1/2 — the run's nested-payload name map, keyed by value-object FQN
     * (`MetaObject.name`), scoped per OUTPUT PACKAGE. Kotlin is a one-class-per-file
     * emitter (KotlinPoet `FileSpec(outPkg, className)`), so its collision domain is the
     * output prompts package: two value-objects sharing a bare short name written into
     * the same package would clobber one `NotePayload.kt`. A nested VO whose bare short
     * name is UNIQUE in its output package emits `<Short>Payload` (byte-identical to
     * pre-ADR-0044 output); a COLLISION emits every member under its package-qualified
     * derived name (`acme::alpha::Note` -> `AcmeAlphaNotePayload`). A still-colliding
     * derived name fails loud with [ERR_PAYLOAD_NAME_COLLISION]. Pure function of the
     * templates — never of emission order.
     */
    protected open fun computePayloadNameMap(
        templates: List<MetaTemplate>,
        loader: MetaDataLoader,
    ): Map<String, String> {
        // FQN -> output package (first reaching template in sorted order wins, matching
        // the run-wide dedupe). The primary VO is template-named, so excluded.
        val voOutPkg = LinkedHashMap<String, String>()
        val orderedFqns = ArrayList<String>()
        for (tmpl in templates) {
            val payloadRef = tmpl.payloadRef ?: continue
            val vo = resolveViewObject(loader, payloadRef) ?: continue
            val nestedPkg = KotlinNaming.promptsPackage(PackageMapping.splitFqn(tmpl.name).first)
            collectNestedClosure(vo, loader, nestedPkg, voOutPkg, orderedFqns, mutableSetOf(vo.name))
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
                nameMap[fqn] = KotlinNaming.payloadName(PackageMapping.splitFqn(fqn).second)
            } else {
                for (fqn in fqns) {
                    val (pkg, short) = PackageMapping.splitFqn(fqn)
                    nameMap[fqn] = KotlinNaming.payloadName(packageQualifiedName(pkg, short))
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
                    "$ERR_PAYLOAD_NAME_COLLISION: payload record name collision: \"${nameMap[fqn]}\" " +
                        "derives from both \"$prev\" and \"$fqn\" — rename one value-object or move " +
                        "it to a package that derives a distinct name"
                )
            }
        }
        return nameMap
    }

    /**
     * ADR-0044 pass 1 — walk [vo]'s transitive nested-payload closure (plain
     * `field.object @objectRef` + `origin.collection @via` edges), assigning each
     * not-yet-seen target VO to [outPkg] (first reaching template wins) and recording it
     * in [orderedFqns]. [seen] is seeded with the primary VO's FQN and is the cycle guard.
     */
    protected fun collectNestedClosure(
        vo: MetaObject,
        loader: MetaDataLoader,
        outPkg: String,
        voOutPkg: MutableMap<String, String>,
        orderedFqns: MutableList<String>,
        seen: MutableSet<String>,
    ) {
        for (field in vo.metaFields) {
            val target = nestedTargetOf(field, loader) ?: continue
            val fqn = target.name
            if (!seen.add(fqn)) continue
            if (!voOutPkg.containsKey(fqn)) {
                voOutPkg[fqn] = outPkg
                orderedFqns.add(fqn)
            }
            collectNestedClosure(target, loader, outPkg, voOutPkg, orderedFqns, seen)
        }
    }

    /**
     * The nested-payload target VO a [field] contributes to the closure, or `null` when
     * it contributes no nested class. Mirrors the resolution in [resolveObjectFieldType]
     * (plain `field.object @objectRef`) and [resolveCollectionType] (`origin.collection
     * @via`) EXACTLY, so the closure walk and the emission walk agree. Passthrough /
     * aggregate / computed / first origins yield scalar types (no nested class).
     */
    protected fun nestedTargetOf(field: MetaField<*>, loader: MetaDataLoader): MetaObject? {
        val origin = field.children.filterIsInstance<MetaOrigin>().firstOrNull()
        if (origin is CollectionOrigin) {
            val via = origin.via ?: return null
            val (parentName, relName) = KotlinGenUtil.splitDottedRef(via) ?: return null
            val parent = KotlinGenUtil.resolveObjectByShortOrFqn(loader, parentName) ?: return null
            val rel = parent.relationships
                .firstOrNull { it.name == relName || it.name.substringAfterLast("::") == relName }
                ?: return null
            val targetRef = rel.objectRef ?: return null
            return KotlinGenUtil.resolveObjectByShortOrFqn(loader, targetRef)
        }
        if (origin != null) return null // passthrough / aggregate / computed / first -> scalar
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
    protected fun packageQualifiedName(kotlinPkg: String, shortName: String): String {
        if (kotlinPkg.isEmpty()) return shortName
        return kotlinPkg.split(".")
            .filter { it.isNotEmpty() }
            .joinToString("") { it.replaceFirstChar { c -> c.uppercaseChar() } } + shortName
    }

    protected open fun emit(
        template: MetaTemplate,
        loader: MetaDataLoader,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
        emittedEnumFqns: MutableSet<String>,
        nameMap: Map<String, String>,
    ) {
        val payloadRef = template.payloadRef ?: return
        val payloadVo = resolveViewObject(loader, payloadRef) ?: return

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val className = KotlinNaming.payloadName(templateShort)

        emitPayloadClass(
            outPkg = outPkg,
            className = className,
            kdoc = "GENERATED — payload for template `${template.name}`.\n",
            voObject = payloadVo,
            loader = loader,
            outRoot = outRoot,
            emittedNestedFqns = emittedNestedFqns,
            emittedEnumFqns = emittedEnumFqns,
            nameMap = nameMap,
        )
    }

    /**
     * Emit a single @Serializable data class for [voObject] into [outPkg].[className],
     * resolving each field's TypeName via [resolveFieldType]. When a field has an
     * `origin.collection`, recursively emits its nested payload class first (per-run
     * deduped via [emittedNestedFqns]).
     */
    protected open fun emitPayloadClass(
        outPkg: String,
        className: String,
        kdoc: String,
        voObject: MetaObject,
        loader: MetaDataLoader,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
        emittedEnumFqns: MutableSet<String>,
        nameMap: Map<String, String>,
    ) {
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(className)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc(kdoc)

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in voObject.metaFields) {
            val type = resolveFieldType(field, voObject, loader, outPkg, outRoot, emittedNestedFqns, emittedEnumFqns, nameMap)
            ctorBuilder.addParameter(ParameterSpec.builder(field.name, type).build())
            typeBuilder.addProperty(
                PropertySpec.builder(field.name, type).initializer(field.name).build()
            )
        }

        FileSpec.builder(outPkg, className)
            .addType(typeBuilder.primaryConstructor(ctorBuilder.build()).build())
            .build()
            .writeTo(outRoot)
    }

    /**
     * Resolve the Kotlin TypeName of a single payload-VO field, honoring any
     * `origin.*` child. Falls back to [KotlinTypeMapper.payloadTypeName] when no
     * origin is present (parsed JSON value for a `field.string @dbColumnType=jsonb` open
     * bag, otherwise identical to `kotlinTypeName`).
     */
    protected open fun resolveFieldType(
        field: MetaField<*>,
        owner: MetaObject,
        loader: MetaDataLoader,
        nestedPkg: String,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
        emittedEnumFqns: MutableSet<String>,
        nameMap: Map<String, String>,
    ): TypeName {
        // ADR-0039/ADR-0029: origin.* NEVER inherits — a derived field's origin is
        // declared-here, so read OWN children (field.children), not resolving.
        val origin = field.children.filterIsInstance<MetaOrigin>().firstOrNull()

        if (origin != null) {
            return when (origin) {
                is PassthroughOrigin -> resolvePassthroughType(origin, loader, field)
                is AggregateOrigin -> resolveAggregateType(origin, loader, field)
                is CollectionOrigin -> resolveCollectionType(
                    origin, loader, nestedPkg, outRoot, emittedNestedFqns, emittedEnumFqns, field, nameMap
                )
                // #195 origin.computed: a row-level value; its type is the field's own declared
                // subType (validation pins the inferred root type == field subType). Conservative
                // nullable — an expression's null-ness is expression-dependent.
                is ComputedOrigin -> KotlinTypeMapper.payloadTypeName(field).copy(nullable = true)
                // #195 origin.first: the @of source column's type, NULLABLE (an empty related set
                // after @filter selects no row → null).
                is FirstOrigin -> resolveFirstType(origin, loader, field)
                else -> KotlinTypeMapper.payloadTypeName(field)
            }
        }

        // field.enum (incl. array-of-enum): type the strict payload field as the generated enum
        // class (the same `<EntityShort><FieldPascal>` / shared-super scheme the entity generator
        // uses), and emit that enum file (deduped per run). Single → `<Enum>`; array → `List<<Enum>>`.
        // The lenient `<Name>Extracted` mirror is UNCHANGED (String / List<String?>) — only the
        // strict payload is enum-typed; the extract mapper bridges String → enum via `valueOf`.
        if (field is EnumField) {
            val enumType = KotlinTypeMapper.enumTypeName(field, owner)
            if (enumType != null) {
                KotlinEnumEmitter.emitEnumFile(owner, field, outRoot, emittedEnumFqns)
                return if (field.isArrayType()) {
                    ClassName("kotlin.collections", "List").parameterizedBy(enumType)
                } else {
                    enumType
                }
            }
        }

        // Naked `field.object @objectRef` (no origin child): emit the nested payload class
        // and return its type (single, or List<TargetPayload> when isArray). Mirrors the
        // Spring port's resolveObjectFieldType — needed so a nested-object payload compiles.
        if (field is ObjectField) {
            return resolveObjectFieldType(field, loader, nestedPkg, outRoot, emittedNestedFqns, emittedEnumFqns, nameMap)
        }

        // Scalar array (`isArray: true` on a non-object field): model as List<ElementType> in the
        // strict payload (matching the cross-port payload shape). Without this, `kotlinTypeName`
        // returns the bare element type and the array semantics are lost.
        val scalarType = KotlinTypeMapper.payloadTypeName(field)
        if (field.isArrayType()) {
            return ClassName("kotlin.collections", "List").parameterizedBy(scalarType)
        }
        return scalarType
    }

    /**
     * Naked `field.object @objectRef`: recursively emit `<TargetShortName>Payload` for the
     * referenced value-object (deduped per run) and return that type — or
     * `List<TargetPayload>` when `isArray: true`. Falls back to the scalar type mapping when
     * the ref can't be resolved or the target is not an `object.value` (defensive — loader
     * validation normally gates these).
     */
    private fun resolveObjectFieldType(
        field: ObjectField,
        loader: MetaDataLoader,
        nestedPkg: String,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
        emittedEnumFqns: MutableSet<String>,
        nameMap: Map<String, String>,
    ): TypeName {
        val fallbackType = { KotlinTypeMapper.payloadTypeName(field) }
        val target = try {
            field.objectRef
        } catch (e: RuntimeException) {
            return fallbackType()
        } ?: return fallbackType()
        if (target.subType != MetaObject.SUBTYPE_VALUE) return fallbackType()

        // ADR-0044 — class name (declaration, file, reference) from the collision-scoped
        // name map (bare when unique in the output package, package-qualified on collision).
        val nestedClassName = nameMap[target.name]
            ?: (PackageMapping.splitFqn(target.name).second + "Payload")
        if (emittedNestedFqns.add(target.name)) {
            emitPayloadClass(
                outPkg = nestedPkg,
                className = nestedClassName,
                kdoc = "GENERATED — nested payload for object field target `${target.name}`.\n",
                voObject = target,
                loader = loader,
                outRoot = outRoot,
                emittedNestedFqns = emittedNestedFqns,
                emittedEnumFqns = emittedEnumFqns,
                nameMap = nameMap,
            )
        }

        val nestedType = ClassName(nestedPkg, nestedClassName)
        return if (field.isArrayType()) {
            ClassName("kotlin.collections", "List").parameterizedBy(nestedType)
        } else {
            nestedType
        }
    }

    /**
     * `origin.passthrough @from "Entity.field"`: resolve to the source field's
     * Kotlin TypeName. Falls back to the payload field's own type if the dotted
     * ref can't be resolved (defensive — the loader's ValidationPhase already
     * gates @from being present and well-formed).
     */
    private fun resolvePassthroughType(
        origin: PassthroughOrigin,
        loader: MetaDataLoader,
        fallbackField: MetaField<*>,
    ): TypeName {
        val from = origin.from ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
        val sourceField = resolveDottedFieldRef(loader, from)
            ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
        return KotlinTypeMapper.payloadTypeName(sourceField)
    }

    /**
     * `origin.aggregate @agg X [@of "Entity.field"]`: type rule —
     *  - count → Long
     *  - avg → Double
     *  - sum/min/max → type of the `@of` field
     *  - any/all → Boolean (a predicate quantifier; empty set → false/true, never null — #195)
     *  - collect → List<T> where T is the `@of` element type (array rollup; empty set → [] — #195)
     */
    private fun resolveAggregateType(
        origin: AggregateOrigin,
        loader: MetaDataLoader,
        fallbackField: MetaField<*>,
    ): TypeName {
        return when (origin.agg) {
            MetaOrigin.AGG_COUNT -> LONG
            MetaOrigin.AGG_AVG -> DOUBLE
            // #195 boolean rollup — a quantifier over the related row-set. Always Boolean,
            // COALESCE-guaranteed non-null (the payload emits fields non-null by default).
            MetaOrigin.AGG_ANY, MetaOrigin.AGG_ALL -> BOOLEAN
            // #195 array rollup — List<element-of-@of>, non-null (empty set → []). The @of names
            // the collected scalar column; payloadTypeName gives its element type.
            MetaOrigin.AGG_COLLECT -> {
                val of = origin.of ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
                val sourceField = resolveDottedFieldRef(loader, of)
                    ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
                ClassName("kotlin.collections", "List")
                    .parameterizedBy(KotlinTypeMapper.payloadTypeName(sourceField))
            }
            MetaOrigin.AGG_SUM, MetaOrigin.AGG_MIN, MetaOrigin.AGG_MAX -> {
                val of = origin.of ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
                val sourceField = resolveDottedFieldRef(loader, of)
                    ?: return KotlinTypeMapper.payloadTypeName(fallbackField)
                KotlinTypeMapper.payloadTypeName(sourceField)
            }
            else -> KotlinTypeMapper.payloadTypeName(fallbackField)
        }
    }

    /**
     * `origin.first @of "Entity.field" @orderBy [...]`: type = the `@of` source column's Kotlin
     * type, made NULLABLE — an empty related set (after `@filter`) selects no row, so the projected
     * value can be null (#195). Falls back to the payload field's own (nullable) type when `@of`
     * can't be resolved (defensive — the loader's ValidationPhase gates `@of` presence/shape).
     */
    private fun resolveFirstType(
        origin: FirstOrigin,
        loader: MetaDataLoader,
        fallbackField: MetaField<*>,
    ): TypeName {
        val of = origin.of ?: return KotlinTypeMapper.payloadTypeName(fallbackField).copy(nullable = true)
        val sourceField = resolveDottedFieldRef(loader, of)
            ?: return KotlinTypeMapper.payloadTypeName(fallbackField).copy(nullable = true)
        return KotlinTypeMapper.payloadTypeName(sourceField).copy(nullable = true)
    }

    /**
     * `origin.collection @via "Parent.relName"`: walk Parent's relationship `relName`
     * to its `@objectRef` target entity, recursively emit a nested payload class
     * (`<TargetShortName>Payload`) into [nestedPkg], and return `List<TargetPayload>`.
     * Dedupe across the whole run via [emittedNestedFqns].
     */
    private fun resolveCollectionType(
        origin: CollectionOrigin,
        loader: MetaDataLoader,
        nestedPkg: String,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
        emittedEnumFqns: MutableSet<String>,
        fallbackField: MetaField<*>,
        nameMap: Map<String, String>,
    ): TypeName {
        val fallbackType = { KotlinTypeMapper.payloadTypeName(fallbackField) }
        val via = origin.via ?: return fallbackType()
        val (parentName, relName) = KotlinGenUtil.splitDottedRef(via) ?: return fallbackType()
        val parent = KotlinGenUtil.resolveObjectByShortOrFqn(loader, parentName) ?: return fallbackType()
        // ADR-0039: relationships are inheritable — RESOLVE via parent.relationships;
        // parent.children (own-only) would miss a relationship inherited via extends.
        val relationship = parent.relationships
            .firstOrNull { it.name == relName || it.name.substringAfterLast("::") == relName }
            ?: return fallbackType()
        val targetRef = relationship.objectRef ?: return fallbackType()
        val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, targetRef) ?: return fallbackType()
        // ADR-0044 — collision-scoped class name (see resolveObjectFieldType).
        val nestedClassName = nameMap[target.name]
            ?: (PackageMapping.splitFqn(target.name).second + "Payload")

        if (emittedNestedFqns.add(target.name)) {
            emitPayloadClass(
                outPkg = nestedPkg,
                className = nestedClassName,
                kdoc = "GENERATED — nested payload for collection target `${target.name}`.\n",
                voObject = target,
                loader = loader,
                outRoot = outRoot,
                emittedNestedFqns = emittedNestedFqns,
                emittedEnumFqns = emittedEnumFqns,
                nameMap = nameMap,
            )
        }

        val listType = ClassName("kotlin.collections", "List")
        return listType.parameterizedBy(ClassName(nestedPkg, nestedClassName))
    }

    /**
     * Resolve a dotted `"Entity.field"` ref to the MetaField on Entity (by short
     * name OR FQN match). Returns null when either half can't be resolved.
     */
    private fun resolveDottedFieldRef(loader: MetaDataLoader, dottedRef: String): MetaField<*>? {
        val (entityName, fieldName) = KotlinGenUtil.splitDottedRef(dottedRef) ?: return null
        val obj = KotlinGenUtil.resolveObjectByShortOrFqn(loader, entityName) ?: return null
        // Fields on a MetaObject are typically stored under their short name, but
        // be defensive against an FQN-stored field-name (matches relationship lookup).
        return obj.metaFields.firstOrNull {
            it.name == fieldName || it.name.substringAfterLast("::") == fieldName
        }
    }

    /** Resolve a `@payloadRef` to its `object.value` (rejects entities — payloads must be VOs). */
    private fun resolveViewObject(loader: MetaDataLoader, ref: String): MetaObject? =
        KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref)
            ?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}.kt"
}
