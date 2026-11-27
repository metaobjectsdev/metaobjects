package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): this sibling stays in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.ConfiguredRequires
import com.metaobjects.generator.kotlin.ExposedApi
import com.metaobjects.generator.kotlin.writer.KotlinWriter

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
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
open class KotlinSpringConfigGenerator : MultiFileDirectGeneratorBase<MetaObject>(), ConfiguredRequires {

    /** `validatorEnabled` (default `true`); the one reading [execute] and [configuredRequires] share. */
    private fun validatorEnabled(): Boolean =
        (getArg("validatorEnabled", "true") ?: "true").equals("true", ignoreCase = true)

    /** The generated validator is referenced only when the startup hook is emitted. */
    override fun configuredRequires(): List<String> =
        if (validatorEnabled()) listOf("validator") else emptyList()

    /** See [KotlinExposedTableGenerator.exposedApi] — same arg, same default (issue #390). */
    protected fun exposedApi(): ExposedApi = ExposedApi.parse(getArg(ExposedApi.ARG_EXPOSED_API))

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val api = exposedApi()
        val pkg = getArg("packageName")
            ?: throw GeneratorException("KotlinSpringConfigGenerator (\"spring-config\"): packageName is required")
        val className = getArg("className", DEFAULT_CLASS_NAME) ?: DEFAULT_CLASS_NAME
        val validatorEnabled = validatorEnabled()
        val resources = (getArg("metadataResource", DEFAULT_METADATA_RESOURCE) ?: DEFAULT_METADATA_RESOURCE)
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val w = KotlinWriter().packageName(pkg)
        if (validatorEnabled) {
            w.doc(
                "GENERATED — wires Exposed's `Database.connect()` from the Spring [DataSource] bean",
                "and runs [MetadataStartupValidator.validate] at app startup.",
                "",
                "If you don't want the validator auto-call, set `metaobjects.validator.enabled=false`.",
            )
        } else {
            // Generated with validatorEnabled=false: no validator hook is emitted, so the
            // KDoc must not say one runs.
            w.doc("GENERATED — wires Exposed's `Database.connect()` from the Spring [DataSource] bean.")
        }
        w.line("@", w.use(CONFIGURATION))
        w.block("class $className(private val dataSource: ${w.use(DATA_SOURCE)}) {") {
            w.block("init {") {
                w.line(w.use(databaseClassName(api)), ".connect(dataSource)")
            }
            if (validatorEnabled) {
                w.blank()
                writeValidatorFn(w, resources)
            }
        }

        val outRoot = Paths.get(outDir.absolutePath)
        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), w.toString())
    }

    /**
     * Write the `@EventListener(ApplicationReadyEvent::class) fun validateMetadata()` function
     * that calls `loadResources(...)` over [resources] and feeds the loader into the generated
     * `MetadataStartupValidator`.
     */
    private fun writeValidatorFn(w: KotlinWriter, resources: List<String>) {
        w.line("@", w.use(EVENT_LISTENER), "(", w.use(APPLICATION_READY_EVENT), "::class)")
        w.block("fun validateMetadata() {") {
            val listOf = KotlinWriter.call("listOf", *resources.map { KotlinWriter.str(it) }.toTypedArray())
            w.line("val loader = ", KotlinWriter.call(w.use(LOAD_RESOURCES), KotlinWriter.str("app"), listOf))
            w.line("MetadataStartupValidator.validate(loader)")
        }
    }

    /**
     * `Database`'s qualified name, keyed by [ExposedApi] (issue #390) — `org.jetbrains.exposed.sql`
     * under 0.x, `org.jetbrains.exposed.v1.jdbc` under 1.x (Database moved to the JDBC tier,
     * same as `SchemaUtils`/`Query`/`selectAll`/`insert`/`update`/`deleteWhere`).
     */
    private fun databaseClassName(api: ExposedApi): String =
        if (api == ExposedApi.V1) "org.jetbrains.exposed.v1.jdbc.Database"
        else "org.jetbrains.exposed.sql.Database"

    private companion object {
        const val DEFAULT_CLASS_NAME = "MetadataExposedConfig"
        const val DEFAULT_METADATA_RESOURCE = "meta.entities.json"

        const val DATA_SOURCE = "javax.sql.DataSource"
        const val CONFIGURATION = "org.springframework.context.annotation.Configuration"
        const val EVENT_LISTENER = "org.springframework.context.event.EventListener"
        const val APPLICATION_READY_EVENT = "org.springframework.boot.context.event.ApplicationReadyEvent"
        const val LOAD_RESOURCES = "com.metaobjects.metadata.ktx.loadResources"
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
