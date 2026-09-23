package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.FindInbound
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.KotlinOutputFormatSpecEmitter
import com.metaobjects.generator.kotlin.PackageMapping

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
import com.metaobjects.generator.util.GeneratedFileWriter

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
 * Emitted only for a RESPONDING `template.prompt` (one whose `@responseRef` resolves to a
 * value object, ADR-0052); every other template is skipped.
 *
 * The SPEC's `rootName` is the response value object's short name (e.g. `"Answer"`), the same
 * rule the TS and C# ports use (ADR-0056).
 *
 * Class-name convention: `<TemplateShort>ResponseFormat` ([KotlinNaming.responseFormatName]).
 *
 * Args:
 * - `outputDir` (required): output directory root.
 */
open class KotlinOutputPromptGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        for (tmpl in FindInbound.inboundTemplates(loader)) {
            emit(tmpl, loader, outRoot)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        // ADR-0052/0053: the gate is @responseRef PRESENCE, not a format value. The old
        // `@format in {json,xml}` gate read the syntax of the OUTBOUND body to decide whether to
        // instruct the model about the syntax of its REPLY — so a text-bodied prompt asking for a
        // JSON answer, the common case, got no fragment at all.
        val shape = FindInbound.responseShape(loader, template)
        if (shape == null) {
            LOG.warn(
                "skipping response-format fragment for {} — no @responseRef, or it does not resolve to an object.value or sourceless object.projection",
                template.name
            )
            return
        }
        val payloadRef = shape.ref
        val payloadVo = shape.vo

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val promptClass = KotlinNaming.responseFormatName(templateShort)
        // The SPEC rootName is the response value object's short name, matching TS and C#
        // (ADR-0056 — there is no template-named response class any more for it to agree with).
        val rootName = PackageMapping.splitFqn(payloadVo.name).second

        val specLiteral = KotlinOutputFormatSpecEmitter.specLiteral(payloadVo, template, rootName)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — output-format prompt for template.output `")
            append(template.name)
            append("`\n")
            append(KotlinNaming.packageHeader(outPkg))
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
        GeneratedFileWriter.write(outFile, src)
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
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}Prompt.kt"

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinOutputPromptGenerator::class.java)
    }
}
