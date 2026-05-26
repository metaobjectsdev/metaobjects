package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.MemberName
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.PropertySpec
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Paths

/**
 * Generator: emits one `@Configuration` Kotlin file per project that wires Exposed's
 * `Database.connect()` from a Spring [javax.sql.DataSource] bean and (optionally) runs
 * the generated `MetadataStartupValidator.validate(loader)` at app startup via
 * `@EventListener(ApplicationReadyEvent::class)`.
 *
 * <p>This eliminates the wiring boilerplate consumers would otherwise hand-write to
 * use the generated Exposed tables + the drift gate together.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required) — output root</li>
 *   <li>{@code packageName} (required) — Kotlin package for the emitted config class</li>
 *   <li>{@code metadataResource} (optional, default {@code "meta.entities.json"}) —
 *       comma-separated list of classpath resource paths the validator loads at
 *       startup</li>
 *   <li>{@code className} (optional, default {@code "MetadataExposedConfig"}) — name of
 *       the generated config class</li>
 *   <li>{@code validatorEnabled} (optional, default {@code "true"}) — when
 *       {@code "false"}, skips emitting the {@code @EventListener} validation hook
 *       (only emits the {@code Database.connect} wiring)</li>
 * </ul>
 */
class KotlinSpringConfigGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val pkg = getArg("packageName")
            ?: throw GeneratorException("packageName is required")
        val className = getArg("className", "MetadataExposedConfig") ?: "MetadataExposedConfig"
        val validatorEnabled = (getArg("validatorEnabled", "true") ?: "true")
            .equals("true", ignoreCase = true)
        val metadataResource = getArg("metadataResource", "meta.entities.json")
            ?: "meta.entities.json"
        val resources = metadataResource.split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val outRoot = Paths.get(outDir.absolutePath)

        val dataSource = ClassName("javax.sql", "DataSource")
        val database = ClassName("org.jetbrains.exposed.sql", "Database")
        val configuration = ClassName("org.springframework.context.annotation", "Configuration")
        val eventListener = ClassName("org.springframework.context.event", "EventListener")
        val applicationReadyEvent = ClassName(
            "org.springframework.boot.context.event", "ApplicationReadyEvent"
        )

        val ctor = FunSpec.constructorBuilder()
            .addParameter(ParameterSpec.builder("dataSource", dataSource).build())
            .build()

        val dsProp = PropertySpec.builder("dataSource", dataSource, KModifier.PRIVATE)
            .initializer("dataSource")
            .build()

        val typeBuilder = com.squareup.kotlinpoet.TypeSpec.classBuilder(className)
            .addKdoc(
                "GENERATED — wires Exposed's `Database.connect()` from the Spring " +
                    "[DataSource] bean\nand runs [MetadataStartupValidator.validate] at " +
                    "app startup.\n\nIf you don't want the validator auto-call, set " +
                    "`metaobjects.validator.enabled=false`.\n"
            )
            .addAnnotation(configuration)
            .primaryConstructor(ctor)
            .addProperty(dsProp)
            .addInitializerBlock(CodeBlock.of("%T.connect(dataSource)\n", database))

        if (validatorEnabled) {
            val resourcesLiteral = buildString {
                append("listOf(")
                resources.forEachIndexed { idx, r ->
                    if (idx > 0) append(", ")
                    append("%S")
                }
                append(")")
            }
            val loadResources = MemberName("com.metaobjects.metadata.ktx", "loadResources")

            val body = CodeBlock.builder()
                .addStatement(
                    "val loader = %M(%S, $resourcesLiteral)",
                    loadResources, "app", *resources.toTypedArray()
                )
                .addStatement("MetadataStartupValidator.validate(loader)")
                .build()

            val listenerAnnotation = AnnotationSpec.builder(eventListener)
                .addMember("%T::class", applicationReadyEvent)
                .build()

            val validateFn = FunSpec.builder("validateMetadata")
                .addAnnotation(listenerAnnotation)
                .returns(Unit::class)
                .addCode(body)
                .build()

            typeBuilder.addFunction(validateFn)
        }

        FileSpec.builder(pkg, className)
            .addType(typeBuilder.build())
            .build()
            .writeTo(outRoot)
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
    override fun getSingleOutputFilename(md: MetaObject): String = ""
}
