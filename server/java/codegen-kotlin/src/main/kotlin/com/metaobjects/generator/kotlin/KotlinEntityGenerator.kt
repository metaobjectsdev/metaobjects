package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.LIST
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
 * Generator: one @Serializable Kotlin data class per `object.entity` and `object.value`.
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
class KotlinEntityGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    /** Real work happens here — sidesteps the parent's print-style writer machinery. */
    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        // emitAbstractShapes (default OFF): when ON, an abstract entity is emitted as a Kotlin
        // `interface` shape (read-only properties) instead of being suppressed. It is NEVER
        // emitted as an instantiable @Serializable data class — abstracts are scaffolding.
        val emitAbstractShapes = (getArg("emitAbstractShapes", "false") ?: "false").toBoolean()
        // Emit a data class for entities AND value objects. Value objects (object.value) are
        // referenced by field.object on entities; the value class must exist for the entity's
        // typed property to resolve.
        // Local-only abstract check (own attribute, not inherited) so concrete subtypes
        // extending an abstract base still emit normally.
        for (obj in loader.metaObjects) {
            if (obj.subType !in EMITTED_SUBTYPES) continue
            if (KotlinGenUtil.isAbstractEntity(obj)) {
                if (emitAbstractShapes) emitAbstractShape(obj, outRoot, loader)
                continue
            }
            emit(obj, outRoot, loader)
        }
    }

    private fun emit(obj: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        // Emit one Kotlin enum class file per `field.enum` child BEFORE the data class
        // so the resolved property type (a ClassName) points at a real file.
        for (field in obj.metaFields) {
            if (field is EnumField) emitEnumFile(obj, field, outRoot)
        }

        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(shortName)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in obj.metaFields) {
            val baseType = resolvePropertyType(field, obj, loader)
            val nullable = !KotlinGenUtil.isRequiredField(field)
            val propType = if (nullable) baseType.copy(nullable = true) else baseType
            val propName = field.name
            val param = ParameterSpec.builder(propName, propType)
                .apply { if (nullable) defaultValue("null") }
                .build()
            ctorBuilder.addParameter(param)
            typeBuilder.addProperty(
                PropertySpec.builder(propName, propType).initializer(propName).build()
            )
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
    private fun emitAbstractShape(obj: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        for (field in obj.metaFields) {
            if (field is EnumField) emitEnumFile(obj, field, outRoot)
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
     * Emit a top-level `@Serializable enum class` for a [field.enum] hung off [owner].
     * Members come from the field's required `@values` string-array attr — emitted
     * verbatim to preserve case (typically SCREAMING_SNAKE_CASE per spec).
     */
    private fun emitEnumFile(owner: MetaObject, field: EnumField, outRoot: Path) {
        val enumClassName = KotlinTypeMapper.enumTypeName(field, owner) ?: return
        val members = readEnumValues(field)
        if (members.isNullOrEmpty()) {
            // Defensive: the loader's ValidationPhase already requires @values be
            // non-empty. Skip emission rather than produce a syntactically broken file.
            return
        }
        val serializable = ClassName("kotlinx.serialization", "Serializable")
        val enumBuilder = TypeSpec.enumBuilder(enumClassName.simpleName)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")
        for (member in members) {
            enumBuilder.addEnumConstant(member)
        }
        FileSpec.builder(enumClassName.packageName, enumClassName.simpleName)
            .addType(enumBuilder.build())
            .build()
            .writeTo(outRoot)
    }

    /** Read the `@values` string-array attr (own-only); null/empty if absent. */
    private fun readEnumValues(field: EnumField): List<String>? {
        if (!field.hasMetaAttr(EnumField.ATTR_VALUES, false)) return null
        val raw = runCatching { field.getMetaAttr(EnumField.ATTR_VALUES, false).value }.getOrNull()
        return when (raw) {
            is List<*> -> raw.mapNotNull { it?.toString() }
            else -> null
        }
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
    private fun resolvePropertyType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): TypeName {
        val element = resolveElementType(field, owner, loader)
        // @isArray fields are a List of the element type (List<T>). isArrayType()
        // covers both the `isArray: true` shorthand and a child @isArray attr.
        // Nullable handling is applied by the caller to the List itself (List<T>?),
        // not the elements — an array of non-null items.
        return if (field.isArrayType) LIST.parameterizedBy(element) else element
    }

    /** The Kotlin TypeName for a single (non-array) element of [field]. */
    private fun resolveElementType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): TypeName {
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
        return KotlinTypeMapper.kotlinTypeName(field)
    }

    /** Read the `@objectRef` attr off a field (own-only); null if absent. */
    private fun readObjectRef(field: MetaField<*>): String? {
        if (!field.hasMetaAttr(ObjectField.ATTR_OBJECTREF, false)) return null
        return runCatching { field.getMetaAttr(ObjectField.ATTR_OBJECTREF, false).valueAsString }
            .getOrNull()
    }

    private companion object {
        /** MetaObject subtypes this generator emits a Kotlin data class for. */
        val EMITTED_SUBTYPES = setOf(MetaObject.SUBTYPE_ENTITY, MetaObject.SUBTYPE_VALUE)
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
