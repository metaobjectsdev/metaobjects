package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.FindInbound
import com.metaobjects.generator.kotlin.Fr019SharedEnum
import com.metaobjects.generator.kotlin.KotlinExtractSchemaEmitter
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
 * Generator: one `<TemplateShortName>Parser.kt` per RESPONDING `template.prompt` (one that
 * declares `@responseRef`, ADR-0052), parsing a model's reply into the `@responseRef` value
 * object's own data class — the one [KotlinEntityGenerator] emits (ADR-0056). This generator
 * declares no strict type of its own.
 *
 * <p>FR-006 — the Kotlin port of the cross-language parser-on-receipt codegen. See
 * `docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md` and ADR-0010 for
 * the cross-port contract; this generator is the Kotlin sibling of TS's `outputParser()`, C#'s
 * `OutputParserGenerator`, and Python's `OutputParserGenerator`.
 *
 * <p>API shape (idiomatic Kotlin dual-API per ADR-0010 §3):
 * <pre>
 *   object &lt;TemplateShortName&gt;Parser {
 *     // JSON replies only. Throws com.fasterxml.jackson.core.JsonProcessingException on bad input.
 *     fun parse&lt;TemplateShortName&gt;(text: String): &lt;ResponseVo&gt;
 *     fun safeParse&lt;TemplateShortName&gt;(text: String): Result&lt;&lt;ResponseVo&gt;&gt;
 *
 *     // Every reply format. Never throws.
 *     fun extractLenient(loader, text, opts): ExtractionResult&lt;&lt;ResponseVo&gt;Extracted&gt;
 *   }
 * </pre>
 *
 * <p>The strict tier decodes with Jackson (`jackson-module-kotlin`), the codec the entity-tier
 * data classes are built for, and fails on an unknown property. The lenient tier returns the
 * value object's all-nullable mirror, which this generator also writes — once per value object
 * per run, beside the value object — via [KotlinExtractSchemaEmitter.emitMirrorFiles].
 *
 * <p><b>Requires [KotlinEntityGenerator] in the same run</b>: the parser and the mirror reference
 * the value object's data class, which only that generator declares.
 *
 * <p><b>Consumer dependency.</b> The strict tier needs
 * `com.fasterxml.jackson.module:jackson-module-kotlin` on the classpath (Spring Boot's web starter
 * brings Jackson; add the Kotlin module if it is absent). The lenient tier needs the MetaObjects
 * runtime (`metaobjects-render`, `metaobjects-om`).
 *
 * <p>The file is laid out by [com.metaobjects.generator.kotlin.writer.KotlinWriter] (ADR-0063).
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
open class KotlinOutputParserGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    /**
     * FR-019: where a `@provided` enum is referenced from, read from the same two generator args
     * every generator that types an enum takes ([Fr019SharedEnum.ProvidedEnumConfig.fromArgs]).
     */
    private val providedEnums: Fr019SharedEnum.ProvidedEnumConfig
        get() = Fr019SharedEnum.ProvidedEnumConfig.fromArgs(args)

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        // ADR-0056 — a mirror is keyed by its value object, so two prompts replying with the same
        // shape share one mirror file. Run-wide dedupe by value-object FQN.
        val emittedMirrors = mutableSetOf<String>()
        // ADR-0052: the direction rule lives in FindInbound, never re-derived here. Only a
        // RESPONDING template.prompt gets a parser file; template.output renders outbound and
        // parses nothing.
        for (tmpl in FindInbound.inboundTemplates(loader)) {
            emit(tmpl, loader, outRoot, emittedMirrors)
        }
    }

    protected open fun emit(
        template: MetaTemplate,
        loader: MetaDataLoader,
        outRoot: Path,
        emittedMirrors: MutableSet<String>,
    ) {
        // ADR-0052: the shape parsed INTO is @responseRef — the reply — never @payloadRef, which
        // types the request this prompt renders outbound. responseShape resolves through the value
        // object resolver every template-tier generator shares.
        val shape = FindInbound.responseShape(loader, template)
        if (shape == null) {
            LOG.warn(
                "skipping output-parser for {} — no @responseRef, or it does not resolve to an object.value or sourceless object.projection",
                template.name
            )
            return
        }
        val responseVo = shape.vo

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val parserClass = KotlinNaming.parserName(templateShort)
        KotlinNaming.requireReferenceable(outPkg, responseVo, "template '${template.name}'")
        // ADR-0056 — the parse result IS the response value object's own data class.
        val responseClass = KotlinNaming.strictRef(responseVo)
        val mirrorClass = KotlinNaming.mirrorRef(responseVo)
        val parseFn = "parse$templateShort"
        val safeParseFn = "safeParse$templateShort"

        // ADR-0053: the reply's syntax is @responseFormat (json|xml, default json) — never
        // @format, which is the syntax of the rendered prompt BODY.
        val format = shape.format
        // The strict tier is JSON-ONLY: strict all-or-nothing semantics layered over the REPAIRING
        // XML reader would throw or accept based on how much repair happened, which is not a
        // contract anyone can reason about. Every responding prompt gets the tolerant tier.
        val emitStrict = !FindInbound.isXml(format)
        val formatEnum = if (FindInbound.isXml(format)) "Format.XML" else "Format.JSON"

        KotlinExtractSchemaEmitter.emitMirrorFiles(responseVo, outRoot, emittedMirrors, providedEnums)

        val w = KotlinWriter().packageName(outPkg)
        w.header("// GENERATED — DO NOT EDIT — response parser for template.prompt `${template.name}`")
        if (emitStrict) w.use("com.fasterxml.jackson.module.kotlin.jacksonObjectMapper")
        w.use("com.metaobjects.loader.MetaDataLoader")
        w.use("com.metaobjects.`object`.extract.MetaObjectExtractor")
        w.use("com.metaobjects.render.extract.Format")
        w.use("com.metaobjects.render.extract.ExtractOptions")
        w.use("com.metaobjects.render.extract.ExtractionResult")
        w.doc("Parser for LLM responses matching the `$templateShort` template.prompt.")
        w.block("object $parserClass {") {
            if (emitStrict) {
                w.line("// Fails on an unknown property: a reply carrying a field the response shape does not")
                w.line("// declare is a contract break, not something to drop silently.")
                w.line("private val mapper = jacksonObjectMapper().findAndRegisterModules()")
                w.blank()
                w.doc(
                    "Parse an LLM response into a typed [$responseClass].",
                    "",
                    "@throws com.fasterxml.jackson.core.JsonProcessingException when the input is not valid JSON for the response shape.",
                )
                w.line("fun $parseFn(text: String): $responseClass =")
                w.indented { w.line("mapper.readValue(text, $responseClass::class.java)") }
                w.blank()
                w.doc("Parse with explicit error handling (Result-style — does not throw).")
                w.line("fun $safeParseFn(text: String): Result<$responseClass> =")
                w.indented { w.line("runCatching { $parseFn(text) }") }
                w.blank()
            }
            w.doc("Payload FQN this parser extracts — resolved against the supplied loader at runtime.")
            w.line("const val PAYLOAD_FQN: String = ", KotlinWriter.str(responseVo.name))
            w.blank()
            w.doc(
                "Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;",
                "never throws. Fully populates nested-object and array-of-object components by",
                "reading the live metadata directly. Resolves this payload's",
                "MetaObject by [PAYLOAD_FQN] from [loader].",
            )
            w.block("fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<$mirrorClass> {") {
                w.line("val mo = loader.getMetaObjectByName(PAYLOAD_FQN)")
                w.line("val raw = MetaObjectExtractor.extract(mo, text, $formatEnum, opts)")
                w.line("// The assembled graph is a ValueObject (a Map<String, Any?>) with nested")
                w.line("// ValueObjects / List<ValueObject> — map it onto the typed mirror graph.")
                w.line("@Suppress(", KotlinWriter.str("UNCHECKED_CAST"), ")")
                w.line("val d = raw.data as? Map<String, Any?>")
                w.line("return ExtractionResult($mirrorClass.fromMap(d), raw.report)")
            }
        }
        val src = w.toString()

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$parserClass.kt")
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
        private val LOG = LoggerFactory.getLogger(KotlinOutputParserGenerator::class.java)
    }
}
