package com.metaobjects.generator.kotlin

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
import com.squareup.kotlinpoet.ParameterSpec
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
        // Emit a data class for entities AND value objects. Value objects (object.value) are
        // referenced by field.object on entities; the value class must exist for the entity's
        // typed property to resolve.
        for (obj in loader.metaObjects) {
            if (obj.subType in EMITTED_SUBTYPES) emit(obj, outRoot, loader)
        }
    }

    private fun emit(obj: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(shortName)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in obj.metaFields) {
            val baseType = resolvePropertyType(field, loader)
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
     * Resolve the Kotlin TypeName for a single property. For `field.object` fields,
     * the type is a reference to the generated data class of the field's `@objectRef`
     * (e.g., `Address` for `field.object @objectRef="Address"`). The `@storage` attr
     * is intentionally NOT consulted here — flattened vs jsonb only affects the
     * persistence column shape, not the in-memory shape.
     */
    private fun resolvePropertyType(field: MetaField<*>, loader: MetaDataLoader): TypeName {
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
