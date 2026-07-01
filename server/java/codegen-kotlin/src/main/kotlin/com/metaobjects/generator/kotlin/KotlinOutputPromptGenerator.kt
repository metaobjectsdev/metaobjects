package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.TemplateConstants
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory

/**
 * Generator: one `<TemplateShortName>OutputPrompt.kt` per `template.output` declaration
 * (where `@format` is `json` or `xml`), emitting a Kotlin `object` with
 * `renderFormat()` / `renderFormat(overrides: PromptOverrides)` backed by
 * `OutputFormatRenderer` from the `metaobjects-render` module.
 *
 * FR-010 — the Kotlin prompt-fragment codegen. Mirrors the structure of
 * [KotlinOutputParserGenerator]: same base class, same package derivation,
 * same stable-name-order iteration, same `@payloadRef` resolution, same
 * defensive skip rules.
 *
 * Emitted object shape:
 * ```kotlin
 * // GENERATED — DO NOT EDIT — output-format prompt for template.output `AnswerOutput`
 * package acme.ai.prompts
 *
 * import com.metaobjects.render.prompt.OutputFormatRenderer
 * import com.metaobjects.render.prompt.OutputFormatSpec
 * import com.metaobjects.render.prompt.PromptField
 * import com.metaobjects.render.prompt.PromptOverrides
 * import com.metaobjects.render.prompt.PromptStyle
 * import com.metaobjects.render.extract.FieldKind
 * import com.metaobjects.render.extract.Format
 *
 * /** Output-format prompt fragment for the `AnswerOutput` template.output. */
 * object AnswerOutputPrompt {
 *     private val SPEC: OutputFormatSpec = OutputFormatSpec(...)
 *     fun renderFormat(): String = OutputFormatRenderer.render(SPEC, PromptOverrides.none())
 *     fun renderFormat(overrides: PromptOverrides): String = OutputFormatRenderer.render(SPEC, overrides)
 * }
 * ```
 *
 * Skips:
 * - `template.prompt` nodes — only outputs need prompt-fragment codegen.
 * - Missing or non-VO `@payloadRef`.
 * - `@format` values other than `json` or `xml` (e.g. `text`).
 *
 * The SPEC's `rootName` is the payload class name derived from the template short name
 * (e.g. `"AnswerPayload"`) — matches the convention used by [KotlinOutputParserGenerator]'s
 * extract codegen so both artifacts agree on the root name.
 *
 * Class-name convention: `<TemplateShort>OutputPrompt` (e.g. template `AnswerOutput` →
 * class `AnswerOutputOutputPrompt` is avoided by using `<TemplateShort>Prompt` form only
 * when the short name already ends in `Output`, otherwise `<TemplateShort>OutputPrompt`).
 * Actually, the simpler consistent convention: suffix is always `Prompt` appended to the
 * capitalized template short name (matching the Java `SpringOutputPromptGenerator`'s
 * `<TemplateShort>Prompt` naming). Example: template `AnswerOutput` → `AnswerOutputPrompt`.
 *
 * Args:
 * - `outputDir` (required): output directory root.
 */
open class KotlinOutputPromptGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        // Stable name order — matches TS/C#/Python/Java deterministic emission.
        // ADR-0039: root-scan discipline — resolving children accessor.
        val outputs = loader.root.getChildren(OutputTemplate::class.java, true)
            .sortedBy { it.name }

        for (tmpl in outputs) {
            emit(tmpl, loader, outRoot)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        // Only emit for json/xml formats.
        val format = template.format
        val supported = TemplateConstants.FORMAT_JSON.equals(format, ignoreCase = true)
            || TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true)
        if (!supported) {
            return
        }

        val payloadRef = template.payloadRef
        if (payloadRef.isNullOrEmpty()) {
            // Loader validation normally catches this first; defensive only.
            LOG.warn(
                "skipping output-prompt for {} — missing @payloadRef",
                template.name
            )
            return
        }
        val payloadVo = resolveValueObject(loader, payloadRef)
        if (payloadVo == null) {
            // @payloadRef resolves to an object.entity (or nothing) — same contract
            // as KotlinPayloadGenerator: payloads MUST be VOs.
            LOG.warn(
                "skipping output-prompt for {} — @payloadRef '{}' does not resolve to an object.value",
                template.name, payloadRef
            )
            return
        }

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val promptClass = KotlinNaming.promptName(templateShort)
        val payloadClass = KotlinNaming.payloadName(templateShort)

        // The SPEC rootName agrees with the payload class name so both prompt and
        // extract artifacts share the same root element name.
        val specLiteral = KotlinOutputFormatSpecEmitter.specLiteral(payloadVo, template, payloadClass)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — output-format prompt for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("import com.metaobjects.render.prompt.OutputFormatRenderer\n")
            append("import com.metaobjects.render.prompt.OutputFormatSpec\n")
            append("import com.metaobjects.render.prompt.PromptField\n")
            append("import com.metaobjects.render.prompt.PromptOverrides\n")
            append("import com.metaobjects.render.prompt.PromptStyle\n")
            append("import com.metaobjects.render.extract.FieldKind\n")
            append("import com.metaobjects.render.extract.Format\n")
            append("\n")
            append("/** Output-format prompt fragment for the `")
            append(templateShort)
            append("` template.output. */\n")
            append("object ")
            append(promptClass)
            append(" {\n")
            append("    private val SPEC: OutputFormatSpec =\n")
            append("        ")
            append(specLiteral)
            append("\n")
            append("    fun renderFormat(): String = OutputFormatRenderer.render(SPEC, PromptOverrides.none())\n")
            append("    fun renderFormat(overrides: PromptOverrides): String = OutputFormatRenderer.render(SPEC, overrides)\n")
            append("}\n")
        }

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$promptClass.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    /** Resolve a `@payloadRef` to its `object.value` (rejects entities — payloads must be VOs). */
    private fun resolveValueObject(loader: MetaDataLoader, ref: String): MetaObject? =
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
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}Prompt.kt"

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinOutputPromptGenerator::class.java)
    }
}
