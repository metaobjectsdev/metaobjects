package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
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
 * <p>DECLARED-TYPE-AUTHORITATIVE (#270): a payload field's property type comes ONLY from
 * its declared `field.<subType>` + `isArray` + `@objectRef` — never from any `origin.*`
 * child it carries (an origin child is IGNORED for typing; the field types exactly as if
 * it were absent). Nullability likewise comes only from the declaration, never from
 * origin semantics. A prompt's payload is a typed projection the author DECLARES, so
 * payload bloat shows up as a diff — matching the origin-blind TS / C# / Java payload
 * emitters. The property's TypeName is resolved as:
 * <ul>
 *   <li>{@code field.enum} — the generated enum class (single, or {@code List<Enum>}).</li>
 *   <li>{@code field.object @objectRef} to an `object.value` — the nested
 *       `<TargetShortName>Payload` (single, or {@code List<TargetPayload>} when isArray),
 *       recursively emitted alongside (deduped per execute() run). This declared edge is
 *       the ONLY nested-payload closure edge.</li>
 *   <li>Otherwise — {@link KotlinTypeMapper#payloadTypeName(MetaField)} (parsed JSON value
 *       for a `field.string @dbColumnType=jsonb` open bag; otherwise the same mapping as
 *       {@code kotlinTypeName}), wrapped {@code List<...>} when isArray.</li>
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
        // Dedupe nested payload classes emitted via declared `field.object @objectRef`
        // edges across all templates in this run. Key = FQN of the source value-object
        // the nested payload was generated from.
        val emittedNestedFqns = mutableSetOf<String>()
        // Run-level dedupe of emitted enum-class files by enum FQN. A `field.enum` payload field is
        // typed as its generated enum class (reusing the entity enum scheme); two fields sharing an
        // abstract enum super collapse onto ONE emitted file.
        val emittedEnumFqns = mutableSetOf<String>()
        // ADR-0039: root-scan discipline — resolving children accessor.
        val templates = loader.root.getChildren(MetaTemplate::class.java, true)
            .sortedBy { it.name }
        // ADR-0044 — collision-scoped nested-payload class names, a pure function of the
        // loaded templates (order-independent). Keyed by VO FQN. Lifted to [KotlinGenUtil]
        // so the extract-tier emitters reuse the SAME name-map algorithm (#228).
        val nameMap = KotlinGenUtil.computePayloadNameMap(templates, loader)
        for (md in templates) {
            emit(md, loader, outRoot, emittedNestedFqns, emittedEnumFqns, nameMap)
        }
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
        // ADR-0042 — resolve @payloadRef under the loader's package-local contract (#228).
        val payloadVo = KotlinGenUtil.resolveValueObjectRef(loader, payloadRef, template.getPackage()) ?: return

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
     * resolving each field's TypeName via [resolveFieldType]. When a field is a declared
     * `field.object @objectRef` to an `object.value`, recursively emits its nested
     * payload class first (per-run deduped via [emittedNestedFqns]).
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
     * Resolve the Kotlin TypeName of a single payload-VO field from its DECLARATION
     * only (#270): `field.<subType>` + `isArray` + `@objectRef`. Any `origin.*` child
     * the field carries is IGNORED — the field types exactly as if the origin child
     * were absent (matching the origin-blind TS / C# / Java payload emitters). Falls
     * back to [KotlinTypeMapper.payloadTypeName] (parsed JSON value for a
     * `field.string @dbColumnType=jsonb` open bag, otherwise identical to
     * `kotlinTypeName`).
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

        // Declared `field.object @objectRef`: emit the nested payload class and return
        // its type (single, or List<TargetPayload> when isArray). Mirrors the Spring
        // port's resolveObjectFieldType — needed so a nested-object payload compiles.
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
     * Declared `field.object @objectRef`: recursively emit `<TargetShortName>Payload` for
     * the referenced value-object (deduped per run) and return that type — or
     * `List<TargetPayload>` when `isArray: true`. Falls back to the scalar type mapping when
     * the ref can't be resolved (a dangling ref IS loader-gated, `ERR_UNRESOLVED_OBJECT_REF`)
     * or when the target is not an `object.value` — the latter is this port's own
     * PRE-EXISTING conservative filter, NOT a loader-enforced contract (no port's loader
     * constrains a nested `@objectRef` target's subtype today; the TS/C# reference emitters
     * and Python do not filter). The legal-target-set ruling is #210's loader-validation
     * call — do not copy this filter to other ports meanwhile.
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
