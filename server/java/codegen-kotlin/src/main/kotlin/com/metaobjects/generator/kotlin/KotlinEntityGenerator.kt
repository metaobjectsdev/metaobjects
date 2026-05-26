package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
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
import com.squareup.kotlinpoet.TypeSpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one @Serializable Kotlin data class per `object.entity`.
 *
 * <p>Skips abstract objects, payload-only `object.value` instances, and any subType other
 * than `entity`. KotlinPoet emits whole files; the parent class's print-style writer
 * machinery is bypassed in favour of a direct override of [execute].
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
        for (entity in loader.metaObjects) {
            if (entity.subType != "entity") continue   // ignore object.value; payload generator handles those
            emit(entity, outRoot)
        }
    }

    private fun emit(entity: MetaObject, outRoot: Path) {
        val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(shortName)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in entity.metaFields) {
            val baseType = KotlinTypeMapper.kotlinTypeName(field)
            val nullable = !isRequired(field)
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
     * Required iff explicit `@required: true` attribute is set on the field; otherwise nullable.
     * MVP heuristic — refined when richer required-detection lands (see fr-003 spec).
     */
    private fun isRequired(field: MetaField<*>): Boolean {
        if (!field.hasMetaAttr(MetaField.ATTR_REQUIRED, true)) return false
        val raw = runCatching { field.getMetaAttr(MetaField.ATTR_REQUIRED, true).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> raw.equals("true", ignoreCase = true)
            else -> false
        }
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
