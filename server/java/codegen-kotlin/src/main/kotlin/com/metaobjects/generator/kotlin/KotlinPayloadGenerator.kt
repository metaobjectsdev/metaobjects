package com.metaobjects.generator.kotlin

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
import com.squareup.kotlinpoet.PropertySpec
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
 * <p>MVP: primitive fields only. `origin.collection`, `origin.aggregate`, and
 * `origin.passthrough` are deferred to follow-up work — see the codegen-kotlin spec §4.3.
 */
class KotlinPayloadGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        for (md in loader.root.children) {
            if (md !is MetaTemplate) continue
            emit(md, loader, outRoot)
        }
    }

    private fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        val payloadRef = template.payloadRef ?: return
        val payloadVo = resolveViewObject(loader, payloadRef) ?: return

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = if (templatePkg.isEmpty()) "prompts" else "$templatePkg.prompts"
        val className = templateShort + "Payload"

        val serializable = ClassName("kotlinx.serialization", "Serializable")

        val typeBuilder = TypeSpec.classBuilder(className)
            .addModifiers(KModifier.DATA)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — payload for template `${template.name}`.\n")

        val ctorBuilder = FunSpec.constructorBuilder()
        for (field in payloadVo.metaFields) {
            val type = KotlinTypeMapper.kotlinTypeName(field)
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

    private fun resolveViewObject(loader: MetaDataLoader, ref: String): MetaObject? {
        // Match by short name OR fully-qualified name; only accept object.value
        for (child in loader.metaObjects) {
            if (child.subType != MetaObject.SUBTYPE_VALUE) continue
            val short = child.name.substringAfterLast("::")
            if (child.name == ref || short == ref) return child
        }
        return null
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
