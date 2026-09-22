package com.metaobjects.generator.kotlin

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
 * <p>Substrate justification (hand-rolled string builder rather than KotlinPoet): the parser file
 * is short, straight-line Kotlin, so the hand-rolled emit is clearer than the equivalent KotlinPoet
 * dance. Same trade-off as [KotlinSpringControllerGenerator] / [KotlinExposedTableGenerator].
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
open class KotlinOutputParserGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

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

        KotlinExtractSchemaEmitter.emitMirrorFiles(responseVo, outRoot, emittedMirrors)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — response parser for template.prompt `")
            append(template.name)
            append("`\n")
            append(KotlinNaming.packageHeader(outPkg))
            if (emitStrict) append("import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper\n")
            append("import com.metaobjects.loader.MetaDataLoader\n")
            append("import com.metaobjects.`object`.extract.MetaObjectExtractor\n")
            append("import com.metaobjects.render.extract.Format\n")
            append("import com.metaobjects.render.extract.ExtractOptions\n")
            append("import com.metaobjects.render.extract.ExtractionResult\n")
            append("\n")
            append("/** Parser for LLM responses matching the `")
            append(templateShort)
            append("` template.prompt. */\n")
            append("object ")
            append(parserClass)
            append(" {\n")
            append("\n")
            if (emitStrict) {
                append("    // Fails on an unknown property: a reply carrying a field the response shape does not\n")
                append("    // declare is a contract break, not something to drop silently.\n")
                append("    private val mapper = jacksonObjectMapper().findAndRegisterModules()\n")
                append("\n")
                append("    /**\n")
                append("     * Parse an LLM response into a typed [")
                append(responseClass)
                append("].\n")
                append("     *\n")
                append("     * @throws com.fasterxml.jackson.core.JsonProcessingException when the input is not valid JSON for the response shape.\n")
                append("     */\n")
                append("    fun ")
                append(parseFn)
                append("(text: String): ")
                append(responseClass)
                append(" =\n")
                append("        mapper.readValue(text, ")
                append(responseClass)
                append("::class.java)\n")
                append("\n")
                append("    /**\n")
                append("     * Parse with explicit error handling (Result-style — does not throw).\n")
                append("     */\n")
                append("    fun ")
                append(safeParseFn)
                append("(text: String): Result<")
                append(responseClass)
                append("> =\n")
                append("        runCatching { ")
                append(parseFn)
                append("(text) }\n")
                append("\n")
            }
            append("    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */\n")
            append("    const val PAYLOAD_FQN: String = \"")
            append(KotlinExtractSchemaEmitter.kotlinStringLiteral(responseVo.name))
            append("\"\n")
            append("\n")
            append("    /**\n")
            append("     * Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;\n")
            append("     * never throws. Fully populates nested-object and array-of-object components by\n")
            append("     * reading the live metadata directly. Resolves this payload's\n")
            append("     * MetaObject by [PAYLOAD_FQN] from [loader].\n")
            append("     */\n")
            append("    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<")
            append(mirrorClass)
            append("> {\n")
            append("        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)\n")
            append("        val raw = MetaObjectExtractor.extract(mo, text, ")
            append(formatEnum)
            append(", opts)\n")
            append("        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested\n")
            append("        // ValueObjects / List<ValueObject> — map it onto the typed mirror graph.\n")
            append("        @Suppress(\"UNCHECKED_CAST\")\n")
            append("        val d = raw.data as? Map<String, Any?>\n")
            append("        return ExtractionResult(")
            append(mirrorClass)
            append(".fromMap(d), raw.report)\n")
            append("    }\n")
            append("}\n")
        }

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
