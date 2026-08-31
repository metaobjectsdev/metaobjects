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
import com.squareup.kotlinpoet.TypeSpec
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
open class KotlinSpringConfigGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val pkg = getArg("packageName")
            ?: throw GeneratorException("packageName is required")
        val className = getArg("className", DEFAULT_CLASS_NAME) ?: DEFAULT_CLASS_NAME
        val validatorEnabled = (getArg("validatorEnabled", "true") ?: "true")
            .equals("true", ignoreCase = true)
        val resources = (getArg("metadataResource", DEFAULT_METADATA_RESOURCE) ?: DEFAULT_METADATA_RESOURCE)
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val typeBuilder = TypeSpec.classBuilder(className)
            .addKdoc(
                "GENERATED — wires Exposed's `Database.connect()` from the Spring " +
                    "[DataSource] bean\nand runs [MetadataStartupValidator.validate] at " +
                    "app startup.\n\nIf you don't want the validator auto-call, set " +
                    "`metaobjects.validator.enabled=false`.\n"
            )
            .addAnnotation(CONFIGURATION)
            .primaryConstructor(
                FunSpec.constructorBuilder()
                    .addParameter(ParameterSpec.builder("dataSource", DATA_SOURCE).build())
                    .build()
            )
            .addProperty(
                PropertySpec.builder("dataSource", DATA_SOURCE, KModifier.PRIVATE)
                    .initializer("dataSource")
                    .build()
            )
            .addInitializerBlock(CodeBlock.of("%T.connect(dataSource)\n", DATABASE))

        if (validatorEnabled) {
            typeBuilder.addFunction(buildValidatorFn(resources))
        }

        KotlinPoetFileWriter.write(
            FileSpec.builder(pkg, className)
                .addType(typeBuilder.build())
                .build(),
            Paths.get(outDir.absolutePath)
        )
    }

    /**
     * Build the `@EventListener(ApplicationReadyEvent::class) fun validateMetadata()` function
     * that calls `loadResources(...)` over [resources] and feeds the loader into the generated
     * `MetadataStartupValidator`.
     */
    private fun buildValidatorFn(resources: List<String>): FunSpec {
        // `listOf("a", "b", ...)` rendered as `listOf(%S, %S, ...)` placeholders so KotlinPoet
        // string-escapes each resource path correctly.
        val resourcesLiteral = resources.joinToString(prefix = "listOf(", postfix = ")") { "%S" }
        val body = CodeBlock.builder()
            .addStatement(
                "val loader = %M(%S, $resourcesLiteral)",
                LOAD_RESOURCES, "app", *resources.toTypedArray()
            )
            .addStatement("MetadataStartupValidator.validate(loader)")
            .build()

        val listenerAnnotation = AnnotationSpec.builder(EVENT_LISTENER)
            .addMember("%T::class", APPLICATION_READY_EVENT)
            .build()

        return FunSpec.builder("validateMetadata")
            .addAnnotation(listenerAnnotation)
            .returns(Unit::class)
            .addCode(body)
            .build()
    }

    private companion object {
        const val DEFAULT_CLASS_NAME = "MetadataExposedConfig"
        const val DEFAULT_METADATA_RESOURCE = "meta.entities.json"

        val DATA_SOURCE = ClassName("javax.sql", "DataSource")
        val DATABASE = ClassName("org.jetbrains.exposed.sql", "Database")
        val CONFIGURATION = ClassName("org.springframework.context.annotation", "Configuration")
        val EVENT_LISTENER = ClassName("org.springframework.context.event", "EventListener")
        val APPLICATION_READY_EVENT =
            ClassName("org.springframework.boot.context.event", "ApplicationReadyEvent")
        val LOAD_RESOURCES = MemberName("com.metaobjects.metadata.ktx", "loadResources")
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
