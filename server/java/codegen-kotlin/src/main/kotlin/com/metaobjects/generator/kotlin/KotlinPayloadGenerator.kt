package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.origin.AggregateOrigin
import com.metaobjects.origin.CollectionOrigin
import com.metaobjects.origin.MetaOrigin
import com.metaobjects.origin.PassthroughOrigin
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.template.MetaTemplate
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
 *       (@agg sum/min/max) — type of the referenced `@of` field.</li>
 *   <li>{@code origin.collection} (@via "Parent.rel") — {@code List<TargetPayload>}, and the
 *       nested payload class is recursively emitted alongside (deduped per execute() run).</li>
 *   <li>No origin child — fall back to {@link KotlinTypeMapper#kotlinTypeName(MetaField)}.</li>
 * </ul>
 */
class KotlinPayloadGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        // Dedupe nested payload classes emitted via origin.collection across all
        // templates in this run. Key = FQN of the source view-object (or entity) the
        // nested payload was generated from.
        val emittedNestedFqns = mutableSetOf<String>()
        for (md in loader.root.children) {
            if (md !is MetaTemplate) continue
            emit(md, loader, outRoot, emittedNestedFqns)
        }
    }

    private fun emit(
        template: MetaTemplate,
        loader: MetaDataLoader,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
    ) {
        val payloadRef = template.payloadRef ?: return
        val payloadVo = resolveViewObject(loader, payloadRef) ?: return

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = if (templatePkg.isEmpty()) "prompts" else "$templatePkg.prompts"
        val className = templateShort + "Payload"

        emitPayloadClass(
            outPkg = outPkg,
            className = className,
            kdoc = "GENERATED — payload for template `${template.name}`.\n",
            voObject = payloadVo,
            loader = loader,
            outRoot = outRoot,
            emittedNestedFqns = emittedNestedFqns,
        )
    }

    /**
     * Emit a single @Serializable data class for [voObject] into [outPkg].[className],
     * resolving each field's TypeName via [resolveFieldType]. When a field has an
     * `origin.collection`, recursively emits its nested payload class first (per-run
     * deduped via [emittedNestedFqns]).
     */
    private fun emitPayloadClass(
        outPkg: String,
        className: String,
        kdoc: String,
        voObject: MetaObject,
        loader: MetaDataLoader,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
    ) {
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(className)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc(kdoc)

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in voObject.metaFields) {
            val type = resolveFieldType(field, loader, outPkg, outRoot, emittedNestedFqns)
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
     * `origin.*` child. Falls back to [KotlinTypeMapper.kotlinTypeName] when no
     * origin is present.
     */
    private fun resolveFieldType(
        field: MetaField<*>,
        loader: MetaDataLoader,
        nestedPkg: String,
        outRoot: Path,
        emittedNestedFqns: MutableSet<String>,
    ): TypeName {
        val origin = field.children.filterIsInstance<MetaOrigin>().firstOrNull()
            ?: return KotlinTypeMapper.kotlinTypeName(field)

        return when (origin) {
            is PassthroughOrigin -> resolvePassthroughType(origin, loader, field)
            is AggregateOrigin -> resolveAggregateType(origin, loader, field)
            is CollectionOrigin -> resolveCollectionType(
                origin, loader, nestedPkg, outRoot, emittedNestedFqns, field
            )
            else -> KotlinTypeMapper.kotlinTypeName(field)
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
        val from = origin.from ?: return KotlinTypeMapper.kotlinTypeName(fallbackField)
        val sourceField = resolveDottedFieldRef(loader, from)
            ?: return KotlinTypeMapper.kotlinTypeName(fallbackField)
        return KotlinTypeMapper.kotlinTypeName(sourceField)
    }

    /**
     * `origin.aggregate @agg X @of "Entity.field"`: type rule —
     *  - count → Long
     *  - avg → Double
     *  - sum/min/max → type of the `@of` field
     */
    private fun resolveAggregateType(
        origin: AggregateOrigin,
        loader: MetaDataLoader,
        fallbackField: MetaField<*>,
    ): TypeName {
        return when (origin.agg) {
            MetaOrigin.AGG_COUNT -> LONG
            MetaOrigin.AGG_AVG -> DOUBLE
            MetaOrigin.AGG_SUM, MetaOrigin.AGG_MIN, MetaOrigin.AGG_MAX -> {
                val of = origin.of ?: return KotlinTypeMapper.kotlinTypeName(fallbackField)
                val sourceField = resolveDottedFieldRef(loader, of)
                    ?: return KotlinTypeMapper.kotlinTypeName(fallbackField)
                KotlinTypeMapper.kotlinTypeName(sourceField)
            }
            else -> KotlinTypeMapper.kotlinTypeName(fallbackField)
        }
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
        fallbackField: MetaField<*>,
    ): TypeName {
        val fallbackType = { KotlinTypeMapper.kotlinTypeName(fallbackField) }
        val via = origin.via ?: return fallbackType()
        val (parentName, relName) = KotlinGenUtil.splitDottedRef(via) ?: return fallbackType()
        val parent = KotlinGenUtil.resolveObjectByShortOrFqn(loader, parentName) ?: return fallbackType()
        val relationship = parent.children
            .filterIsInstance<MetaRelationship>()
            .firstOrNull { it.name == relName || it.name.substringAfterLast("::") == relName }
            ?: return fallbackType()
        val targetRef = relationship.objectRef ?: return fallbackType()
        val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, targetRef) ?: return fallbackType()
        val nestedClassName = PackageMapping.splitFqn(target.name).second + "Payload"

        if (emittedNestedFqns.add(target.name)) {
            emitPayloadClass(
                outPkg = nestedPkg,
                className = nestedClassName,
                kdoc = "GENERATED — nested payload for collection target `${target.name}`.\n",
                voObject = target,
                loader = loader,
                outRoot = outRoot,
                emittedNestedFqns = emittedNestedFqns,
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
