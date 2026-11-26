package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.FindInbound
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.generator.kotlin.writer.KotlinWriter

import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths
import org.slf4j.LoggerFactory
import com.metaobjects.generator.util.GeneratedFileWriter

/**
 * Cross-port Extractor codegen (Kotlin port) — the `extract` tier over the existing tolerant
 * extract. Emits one `<TemplateShortName>Extractor.kt` per RESPONDING `template.prompt`.
 *
 * <p>The emitted `object <Name>Extractor` turns dirty LLM text into the `@responseRef` value
 * object's strict data class in one call. It runs the nested-capable tolerant extract emitted by
 * [KotlinOutputParserGenerator] (`<Name>Parser.extractLenient(loader, text)`, which assembles the
 * full nested object graph through the runtime `MetaObjectExtractor`), throws
 * [com.metaobjects.render.extract.ExtractException] iff a `@required` field was lost, and otherwise
 * converts the value object's all-nullable mirror with its own `toStrict()`. `extractLenient` is
 * re-exposed unchanged.
 *
 * <p>ADR-0056: the mirror and its `toStrict()` belong to the value object, not the template —
 * [KotlinExtractSchemaEmitter] writes them once, beside the value object. This generator declares
 * no type and no mapper of its own, so two prompts replying with one shape share both.
 *
 * <p><b>Requires [KotlinOutputParserGenerator] and [KotlinEntityGenerator] in the same run.</b>
 *
 * <p>Cross-port parity: the Kotlin sibling of TS `renderExtractor`, the Python
 * `ExtractorGenerator`, the C# `ExtractorGenerator`, and the Java `ExtractorCodeGenerator`.
 */
open class KotlinExtractorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        // ADR-0052: the direction rule lives in FindInbound, never re-derived here. Only a
        // RESPONDING template.prompt gets an extractor; template.output parses nothing.
        for (tmpl in FindInbound.inboundTemplates(loader)) {
            emit(tmpl, loader, outRoot)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        // ADR-0052: the extract tier is INBOUND — it reads a model's reply, so it binds
        // @responseRef, never @payloadRef (which types the request rendered outbound).
        val shape = FindInbound.responseShape(loader, template)
        if (shape == null) {
            LOG.warn(
                "skipping extractor for {} — no @responseRef, or it does not resolve to an object.value or sourceless object.projection",
                template.name
            )
            return
        }
        val responseVo = shape.vo

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val extractorClass = KotlinNaming.extractorName(templateShort)
        val parserClass = KotlinNaming.parserName(templateShort)
        KotlinNaming.requireReferenceable(outPkg, responseVo, "template '${template.name}'")
        val strict = KotlinNaming.strictRef(responseVo)
        val mirror = KotlinNaming.mirrorRef(responseVo)

        val w = KotlinWriter().packageName(outPkg)
        w.header("// GENERATED — DO NOT EDIT — extractor for template.prompt `${template.name}`")
        w.use("com.metaobjects.loader.MetaDataLoader")
        w.use("com.metaobjects.render.extract.ExtractException")
        w.use("com.metaobjects.render.extract.ExtractOptions")
        w.use("com.metaobjects.render.extract.ExtractionResult")
        w.doc(
            "The `extract` tier for the `$templateShort` template.prompt — turns dirty LLM text into a fully-typed",
            "[$strict] graph (nested objects + arrays-of-objects populated) in one call.",
        )
        w.block("object $extractorClass {") {
            w.doc(
                "Extract a fully-typed [$strict] from dirty [text], resolving the response shape's MetaObject",
                "from [loader]. Runs the tolerant extract, then converts the mirror to the strict value object.",
                "",
                "@throws ExtractException iff a `@required` field was lost, or present but unusable (MALFORMED — an",
                "undeclared enum member, text where a number belongs): the strict opt-in gate.",
            )
            w.line("@JvmOverloads")
            w.block("fun extract(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): $strict {") {
                w.line("val r = $parserClass.extractLenient(loader, text, opts)")
                w.block("if (r.report.hasLostRequired() || r.report.hasMalformedRequired()) {") {
                    w.line("throw ExtractException(r.report.lostRequired(), r.report.malformedRequired())")
                }
                w.line("return r.data!!.toStrict()")
            }
            w.blank()
            w.doc(
                "Re-exposes the nested-capable tolerant extract; never throws. Inspect `report` for",
                "lost/malformed/defaulted fields. Returns the all-nullable [$mirror] mirror (not the strict value object).",
            )
            w.line("@JvmOverloads")
            w.line("fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<$mirror> =")
            w.indented { w.line("$parserClass.extractLenient(loader, text, opts)") }
        }
        val src = w.toString()

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$extractorClass.kt")
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
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}.kt"

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinExtractorGenerator::class.java)
    }
}
