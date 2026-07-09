package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.validator.ArrayValidator
import com.metaobjects.validator.LengthValidator
import com.metaobjects.validator.MetaValidator
import com.metaobjects.validator.NumericValidator
import com.metaobjects.validator.RegexValidator
import com.metaobjects.validator.RequiredValidator
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.LIST
import com.squareup.kotlinpoet.MAP
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one plain Kotlin data class (Jackson-compatible) per `object.entity` and
 * `object.value`. No kotlinx `@Serializable` — see [emit] for why.
 *
 * <p>Skips abstract objects and any subType other than `entity` or `value`. KotlinPoet emits
 * whole files; the parent class's print-style writer machinery is bypassed in favour of a
 * direct override of [execute].
 *
 * <p>Nested objects: when a parent field is a `field.object` with `@objectRef`, the parent
 * data class gets a typed property referencing the generated `object.value` data class
 * (e.g., `val address: Address`). The `@storage` attr (`flattened` / `jsonb`) does not
 * affect Kotlin type emission — it only affects the Exposed table's column shape.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root; package directories are
 *       created under it.</li>
 * </ul>
 */
open class KotlinEntityGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    /**
     * FR-019 per-port config for resolving `@provided` enum namespaces, parsed from the
     * `providedEnumNamespace` (single fallback) + `providedEnumPackages` (package→namespace map)
     * generator args. Empty by default; a referenced provided enum with no resolvable namespace is
     * a codegen-time error.
     */
    private var fr019Config = Fr019SharedEnum.ProvidedEnumConfig(null, emptyMap())

    /** Real work happens here — sidesteps the parent's print-style writer machinery. */
    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        fr019Config = Fr019SharedEnum.ProvidedEnumConfig.of(
            getArg("providedEnumNamespace"), getArg("providedEnumPackages"))
        // emitAbstractShapes (default OFF): when ON, an abstract entity is emitted as a Kotlin
        // `interface` shape (read-only properties) instead of being suppressed. It is NEVER
        // emitted as an instantiable data class — abstracts are scaffolding.
        val emitAbstractShapes = (getArg("emitAbstractShapes", "false") ?: "false").toBoolean()
        // Run-level dedupe of emitted enum-class files by enum FQN: two fields sharing an
        // abstract enum super (resolved by KotlinTypeMapper.enumTypeName) collapse onto one file.
        val emittedEnumFqns = mutableSetOf<String>()
        // Emit a data class for entities AND value objects. Value objects (object.value) are
        // referenced by field.object on entities; the value class must exist for the entity's
        // typed property to resolve.
        // Local-only abstract check (own attribute, not inherited) so concrete subtypes
        // extending an abstract base still emit normally.
        for (obj in loader.metaObjects) {
            if (obj.subType !in EMITTED_SUBTYPES) continue
            if (KotlinGenUtil.isAbstractEntity(obj)) {
                if (emitAbstractShapes) emitAbstractShape(obj, outRoot, loader, emittedEnumFqns)
                continue
            }
            // FR-017 TPH: a discriminator subtype folds into its base's union data class +
            // discriminator enum. A per-subtype data class is dead and re-emits the inherited
            // enum under a spurious name. Mirror the controller/table skip.
            if (KotlinTphPlan.isTphSubtype(obj)) continue
            emit(obj, outRoot, loader, emittedEnumFqns)
        }
    }

    protected open fun emit(obj: MetaObject, outRoot: Path, loader: MetaDataLoader, emittedEnumFqns: MutableSet<String>) {
        // Emit one Kotlin enum class file per `field.enum` child BEFORE the data class
        // so the resolved property type (a ClassName) points at a real file. Deduped per run.
        for (field in obj.metaFields) {
            // FR-019: a @provided shared enum is referenced externally, never materialized — skip it.
            if (field is EnumField && !Fr019SharedEnum.isProvidedEnumField(field))
                KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns)
        }
        // FR-017 TPH: the base union folds in subtype-only fields (below). A folded field.enum
        // resolves to a typed enum ClassName, so its enum file must be emitted here (owner = base,
        // matching the fold's type resolution) — the declaring subtype is skipped in execute(), so
        // no other pass emits it. No-op for a non-TPH entity (collectSubtypeFields is empty).
        for (field in KotlinTphPlan.collectSubtypeFields(obj, loader)) {
            if (field is EnumField && !Fr019SharedEnum.isProvidedEnumField(field))
                KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns)
        }

        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)

        // NO kotlinx @Serializable: entity/value/projection data classes are plain
        // (Jackson-compatible) data classes. The annotation was decorative — no build enables
        // the kotlinx-serialization compiler plugin for these, and the moment one did, every
        // class carrying a java.util.UUID / java.time.* / java.math.BigDecimal / java.net.* field
        // would fail to compile (kotlinx has no built-in serializer for those). Jackson (the codec
        // every consumer actually uses) round-trips them with zero per-type plumbing. Only
        // KotlinPayloadGenerator's prompt payloads + KotlinEnumEmitter's enums keep @Serializable
        // (FR-006 parse()/safeParse() genuinely kotlinx-decode those).
        val typeBuilder = TypeSpec.classBuilder(shortName)
            .addModifiers(KModifier.DATA)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        // FR-017 TPH: a discriminator base's data class is the UNION of subtype columns and serves
        // as the partial-PATCH-friendly wire body — every property is nullable + defaulted + carries
        // NO validation (a per-subtype POST/PATCH supplies only its own columns; the DB column
        // nullability is the real constraint). Non-TPH entities keep their per-field required rules.
        val tphBase = KotlinTphPlan.isTphBase(obj, loader)

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in obj.metaFields) {
            val baseType = resolvePropertyType(field, obj, loader)
            val nullable = tphBase || !KotlinGenUtil.isRequiredField(field)
            val propType = if (nullable) baseType.copy(nullable = true) else baseType
            val propName = field.name
            val param = ParameterSpec.builder(propName, propType)
                .apply { if (nullable) defaultValue("null") }
                .build()
            ctorBuilder.addParameter(param)
            val propBuilder = PropertySpec.builder(propName, propType).initializer(propName)
            if (!tphBase) {
                for (annotation in validationAnnotations(field)) {
                    propBuilder.addAnnotation(annotation)
                }
            }
            typeBuilder.addProperty(propBuilder.build())
        }

        // FR-017 TPH: a discriminator base's data class carries the UNION of subtype columns (each
        // NULLABLE, no validation) so one wire shape backs the polymorphic + per-subtype endpoints.
        // collectSubtypeFields is empty for a non-TPH entity (the loop is then a no-op).
        for (field in KotlinTphPlan.collectSubtypeFields(obj, loader)) {
            val propType = resolvePropertyType(field, obj, loader).copy(nullable = true)
            val propName = field.name
            ctorBuilder.addParameter(ParameterSpec.builder(propName, propType).defaultValue("null").build())
            typeBuilder.addProperty(PropertySpec.builder(propName, propType).initializer(propName).build())
        }

        val fileSpec = FileSpec.builder(pkg, shortName)
            .addType(typeBuilder.primaryConstructor(ctorBuilder.build()).build())
            .build()

        fileSpec.writeTo(outRoot)
    }

    /**
     * Emit an abstract entity as a Kotlin `interface` shape: one read-only `val` property per
     * field, reusing the same property-type resolution + required/nullable rules as [emit].
     * No `@Serializable` and no constructor — an interface is not instantiable, mirroring the
     * "abstract = scaffolding, never a write artifact" invariant while still giving concrete
     * subtypes a shared shape to implement. Enum-field files are still emitted so property
     * types resolve. Written to the same package path/file (`<Name>.kt`) as [emit] would use.
     */
    protected open fun emitAbstractShape(obj: MetaObject, outRoot: Path, loader: MetaDataLoader, emittedEnumFqns: MutableSet<String>) {
        for (field in obj.metaFields) {
            // FR-019: a @provided shared enum is referenced externally, never materialized — skip it.
            if (field is EnumField && !Fr019SharedEnum.isProvidedEnumField(field))
                KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns)
        }

        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)

        val typeBuilder = TypeSpec.interfaceBuilder(shortName)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        for (field in obj.metaFields) {
            val baseType = resolvePropertyType(field, obj, loader)
            val nullable = !KotlinGenUtil.isRequiredField(field)
            val propType = if (nullable) baseType.copy(nullable = true) else baseType
            typeBuilder.addProperty(
                PropertySpec.builder(field.name, propType).build()
            )
        }

        FileSpec.builder(pkg, shortName)
            .addType(typeBuilder.build())
            .build()
            .writeTo(outRoot)
    }

    /**
     * Resolve the Kotlin TypeName for a single property. For `field.object` fields,
     * the type is a reference to the generated data class of the field's `@objectRef`
     * (e.g., `Address` for `field.object @objectRef="Address"`). For `field.enum`
     * fields, the type is the typed enum class generated alongside the entity
     * (e.g., `PlayerStatus` for `Player.status`). The `@storage` attr is intentionally
     * NOT consulted here — flattened vs jsonb only affects the persistence column shape,
     * not the in-memory shape.
     */
    protected open fun resolvePropertyType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): TypeName {
        val element = resolveElementType(field, owner, loader)
        // @isArray fields are a List of the element type (List<T>). isArrayType()
        // covers both the `isArray: true` shorthand and a child @isArray attr.
        // Nullable handling is applied by the caller to the List itself (List<T>?),
        // not the elements — an array of non-null items.
        return if (field.isArrayType) LIST.parameterizedBy(element) else element
    }

    /** The Kotlin TypeName for a single (non-array) element of [field]. */
    protected open fun resolveElementType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): TypeName {
        // FR-019: a @provided shared enum is referenced at its configured external namespace
        // (<ns>.E) instead of the materialized in-package class; an unresolved namespace throws.
        Fr019SharedEnum.providedClassName(field, fr019Config)?.let { return it }
        // field.enum → typed enum class generated alongside this entity.
        KotlinTypeMapper.enumTypeName(field, owner)?.let { return it }
        if (field is ObjectField) {
            val ref = readObjectRef(field)
            val target = ref?.let { KotlinGenUtil.resolveObjectByShortOrFqn(loader, it) }
            if (target != null) {
                val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
                return ClassName(targetPkg, targetShort)
            }
        }
        // field.map → Map<String, V>. The value is the @valueType scalar (handled by
        // kotlinTypeName below) or, for an @objectRef map, the referenced VO data class —
        // which needs the loader to resolve, so build the Map<String, VO> here.
        if (field is MapField) {
            val ref = readObjectRef(field)
            val target = ref?.let { KotlinGenUtil.resolveObjectByShortOrFqn(loader, it) }
            if (target != null) {
                val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
                return MAP.parameterizedBy(STRING, ClassName(targetPkg, targetShort))
            }
        }
        return KotlinTypeMapper.kotlinTypeName(field)
    }

    /** Read the `@objectRef` attr off a field (own-only); null if absent. */
    private fun readObjectRef(field: MetaField<*>): String? {
        if (!field.hasMetaAttr(ObjectField.ATTR_OBJECTREF, true)) return null
        return runCatching { field.getMetaAttr(ObjectField.ATTR_OBJECTREF, true).valueAsString }
            .getOrNull()
    }

    // === validation (SP-C validator parity, Unit 5) =========================

    /**
     * Build the `@field:`-site-targeted jakarta.validation annotations for a generated
     * property from the field's constraint metadata — both field attrs (`@required`,
     * `@maxLength`) and `validator.*` children (length / regex / numeric / array).
     * Returns an empty list when the field carries no constraints.
     *
     * <p>The Kotlin entity data class IS the controller request body
     * (`@RequestBody dto: <Entity>` in [KotlinSpringControllerGenerator]); these
     * annotations make Spring's `@Valid` enforce the constraints at the boundary.
     * Site target is [AnnotationSpec.UseSiteTarget.FIELD] because jakarta's reflective
     * validator reads the backing field, not the Kotlin property/getter.
     *
     * <p>Cross-port semantics (the SP-C validator-parity contract — mirrors the Spring
     * port's `SpringDtoGenerator`):
     * <ul>
     *   <li>required (field `@required` or `validator.required`) → `@NotNull`, plus
     *       `@NotBlank` for non-array strings so an empty string fails too.</li>
     *   <li>`validator.length @min` + field `@maxLength` → `@Size(min=…, max=…)`.</li>
     *   <li>`validator.regex @pattern` → `@Pattern(regexp=…)`.</li>
     *   <li>`validator.numeric @min/@max` → `@Min(…)` / `@Max(…)`.</li>
     *   <li>`validator.array @min/@max` → `@Size(min=…, max=…)` on the `List`.</li>
     * </ul>
     */
    protected open fun validationAnnotations(field: MetaField<*>): List<AnnotationSpec> {
        val isArray = field.isArrayType
        val isString = field is StringField
        val out = mutableListOf<AnnotationSpec>()

        val required = KotlinGenUtil.isRequiredField(field) || hasValidator(field, RequiredValidator::class.java)
        if (required) {
            out.add(constraint(NOT_NULL))
            if (isString && !isArray) out.add(constraint(NOT_BLANK))
        }

        // String length: combine validator.length @min with the field-level @maxLength cap.
        var lengthMin: Int? = null
        var lengthMax: Int? = null
        validator(field, LengthValidator::class.java)?.let { length ->
            lengthMin = attrInt(length, LengthValidator.ATTR_MIN)
            lengthMax = attrInt(length, LengthValidator.ATTR_MAX)
        }
        attrInt(field, StringField.ATTR_MAX_LENGTH)?.let { lengthMax = it }
        if (lengthMin != null || lengthMax != null) {
            out.add(sizeAnnotation(lengthMin, lengthMax))
        }

        // Regex pattern.
        validator(field, RegexValidator::class.java)?.let { regex ->
            regex.resolvePattern()?.let { pattern ->
                out.add(
                    AnnotationSpec.builder(PATTERN)
                        .useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
                        .addMember("regexp = %S", pattern)
                        .build()
                )
            }
        }

        // Numeric value bounds.
        validator(field, NumericValidator::class.java)?.let { numeric ->
            attrInt(numeric, NumericValidator.ATTR_MIN)?.let { min ->
                out.add(
                    AnnotationSpec.builder(MIN)
                        .useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
                        .addMember("value = %L", min.toLong())
                        .build()
                )
            }
            attrInt(numeric, NumericValidator.ATTR_MAX)?.let { max ->
                out.add(
                    AnnotationSpec.builder(MAX)
                        .useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
                        .addMember("value = %L", max.toLong())
                        .build()
                )
            }
        }

        // Array element-count bounds → @Size on the List property.
        validator(field, ArrayValidator::class.java)?.let { array ->
            val min = attrInt(array, ArrayValidator.ATTR_MIN)
            val max = attrInt(array, ArrayValidator.ATTR_MAX)
            if (min != null || max != null) out.add(sizeAnnotation(min, max))
        }

        // ADR-0036/0037 Wave 3 — @stringFormat on a plain string field. The canonical
        // matcher per format lives HERE in codegen (NOT author validator.regex), since
        // cross-language regex engines diverge. email → @field:Email; hostname → a
        // canonical DNS-hostname @field:Pattern check.
        if (isString && !isArray && field.hasMetaAttr(StringField.ATTR_STRING_FORMAT)) {
            when (field.getMetaAttr(StringField.ATTR_STRING_FORMAT).value?.toString()?.trim()) {
                StringField.STRING_FORMAT_EMAIL -> out.add(constraint(EMAIL))
                StringField.STRING_FORMAT_HOSTNAME -> out.add(
                    AnnotationSpec.builder(PATTERN)
                        .useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
                        .addMember("regexp = %S", HOSTNAME_REGEX)
                        .build()
                )
            }
        }

        return out
    }

    /** A no-member `@field:`-targeted constraint annotation (e.g. `@field:NotNull`). */
    private fun constraint(type: ClassName): AnnotationSpec =
        AnnotationSpec.builder(type)
            .useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
            .build()

    /** `@field:Size(min = …, max = …)` — each bound omitted when null. */
    private fun sizeAnnotation(min: Int?, max: Int?): AnnotationSpec {
        val b = AnnotationSpec.builder(SIZE).useSiteTarget(AnnotationSpec.UseSiteTarget.FIELD)
        if (min != null) b.addMember("min = %L", min)
        if (max != null) b.addMember("max = %L", max)
        return b.build()
    }

    /** Read an int-valued attr from a node, trying each name in order; null when absent/unparseable. */
    private fun attrInt(node: MetaData, vararg attrNames: String): Int? {
        for (attr in attrNames) {
            if (node.hasMetaAttr(attr)) {
                return runCatching { node.getMetaAttr(attr).valueAsString.trim().toInt() }.getOrNull()
            }
        }
        return null
    }

    private fun <V : MetaValidator> validator(field: MetaField<*>, type: Class<V>): V? {
        // ADR-0039: resolving member iteration — getChildren(type) walks the extends
        // super chain, so a concrete field inherits validators from an abstract base.
        // A raw field.children read would miss inherited validators.
        for (child in field.getChildren(MetaValidator::class.java, true)) {
            if (type.isInstance(child)) return type.cast(child)
        }
        return null
    }

    private fun hasValidator(field: MetaField<*>, type: Class<out MetaValidator>): Boolean =
        validator(field, type) != null

    private companion object {
        /** MetaObject subtypes this generator emits a Kotlin data class for.
         *  FR-024 (ADR-0028): object.projection included — a derived read-only
         *  representation still needs its data class for query results. */
        val EMITTED_SUBTYPES = setOf(
            MetaObject.SUBTYPE_ENTITY,
            MetaObject.SUBTYPE_VALUE,
            MetaObject.SUBTYPE_PROJECTION,
        )

        // jakarta.validation.constraints annotation types (SP-C validator parity).
        private const val JAKARTA_CONSTRAINTS = "jakarta.validation.constraints"
        val NOT_NULL = ClassName(JAKARTA_CONSTRAINTS, "NotNull")
        val NOT_BLANK = ClassName(JAKARTA_CONSTRAINTS, "NotBlank")
        val SIZE = ClassName(JAKARTA_CONSTRAINTS, "Size")
        val PATTERN = ClassName(JAKARTA_CONSTRAINTS, "Pattern")
        val MIN = ClassName(JAKARTA_CONSTRAINTS, "Min")
        val MAX = ClassName(JAKARTA_CONSTRAINTS, "Max")
        val EMAIL = ClassName(JAKARTA_CONSTRAINTS, "Email")

        /**
         * Canonical DNS-hostname matcher for `@stringFormat: hostname` (ADR-0036/0037 Wave 3).
         * Codegen-owned (NOT author `validator.regex`) — one or more dot-separated labels, each
         * 1–63 chars of alphanumerics/hyphens not starting/ending with a hyphen. Byte-identical
         * to the Spring port's `SpringDtoGenerator.HOSTNAME_REGEX`.
         */
        const val HOSTNAME_REGEX =
            "^(?=.{1,253}\$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\$"
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    // KotlinPoet writes whole files in execute(); the parent's print-writer pipeline is unused.
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).second + ".kt"
}
