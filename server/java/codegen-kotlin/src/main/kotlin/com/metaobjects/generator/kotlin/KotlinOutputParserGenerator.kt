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
 * Generator: one `<TemplateShortName>Parser.kt` per `template.output` declaration,
 * emitting a typed parser around the `@payloadRef` payload-VO data class produced
 * by [KotlinPayloadGenerator] (no payload-shape re-declaration).
 *
 * <p>FR-006 — the Kotlin port of the cross-language template-output parser
 * codegen. See `docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md`
 * and ADR-0010 for the cross-port contract; this generator is the Kotlin sibling
 * of TS's `outputParser()`, C#'s `OutputParserGenerator`, and Python's
 * `OutputParserGenerator`.
 *
 * <p>API shape (idiomatic Kotlin dual-API per ADR-0010 §3):
 * <pre>
 *   object &lt;TemplateShortName&gt;Parser {
 *     private val json: Json = Json { ignoreUnknownKeys = false }
 *
 *     // Throws kotlinx.serialization.SerializationException on bad input.
 *     fun parse&lt;TemplateShortName&gt;(text: String): &lt;TemplateShortName&gt;Payload
 *
 *     // Result-style — does not throw. Wraps the above in runCatching { }.
 *     fun safeParse&lt;TemplateShortName&gt;(text: String): Result&lt;&lt;TemplateShortName&gt;Payload&gt;
 *   }
 * </pre>
 *
 * <p>Skips and defensive cases (mirrors the cross-port behavior):
 * <ul>
 *   <li><b>template.prompt</b> is ignored — only outputs need parsing.</li>
 *   <li>Missing `@payloadRef` — skipped with a warning (loader's
 *       validation pass normally rejects this first; defensive only).</li>
 *   <li>`@payloadRef` resolves to a non-VO target (e.g. `object.entity`) —
 *       skipped (same contract as [KotlinPayloadGenerator]).</li>
 *   <li>Outputs are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p>The emitted file's package matches [KotlinPayloadGenerator]'s
 * (`<entity-pkg>.prompts`) so the payload data class import is implicit
 * (same-package reference).
 *
 * <p><b>Consumer dependency.</b> The emitted parser file imports from
 * `kotlinx.serialization.json` and calls `Json.decodeFromString&lt;T&gt;(text)`.
 * Consumers must add `org.jetbrains.kotlinx:kotlinx-serialization-json` (the
 * JSON artifact, not just `kotlinx-serialization-core` which is already
 * needed for `@Serializable`) to their build's runtime classpath, plus the
 * `kotlin("plugin.serialization")` Gradle plugin to compile the payload
 * class's `@Serializable` annotation. See `KNOWN_GAPS.md` for the
 * consumer-wiring contract.
 *
 * <p>Substrate justification (hand-rolled string builder rather than KotlinPoet):
 * the parser file is ~25 lines of trivial Kotlin with no generic type machinery,
 * so the hand-rolled emit is clearer than the equivalent KotlinPoet dance with
 * `%T` placeholders for `Result<Payload>` etc. Same trade-off as
 * [KotlinSpringControllerGenerator] / [KotlinExposedTableGenerator].
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

        // Stable name order — matches TS/C#/Python deterministic emission.
        val outputs = loader.root.children
            .filterIsInstance<OutputTemplate>()
            .sortedBy { it.name }

        for (tmpl in outputs) {
            emit(tmpl, loader, outRoot)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
        val payloadRef = template.payloadRef
        if (payloadRef.isNullOrEmpty()) {
            // Loader validation normally catches this first; defensive only.
            LOG.warn(
                "skipping output-parser for {} — missing @payloadRef",
                template.name
            )
            return
        }
        val payloadVo = resolveViewObject(loader, payloadRef)
        if (payloadVo == null) {
            // @payloadRef resolves to an object.entity (or nothing) — same contract
            // as KotlinPayloadGenerator: payloads MUST be VOs.
            LOG.warn(
                "skipping output-parser for {} — @payloadRef '{}' does not resolve to an object.value",
                template.name, payloadRef
            )
            return
        }

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = if (templatePkg.isEmpty()) "prompts" else "$templatePkg.prompts"
        val parserClass = templateShort + "Parser"
        val payloadClass = templateShort + "Payload"
        val extractedClass = templateShort + "Extracted"
        val parseFn = "parse$templateShort"
        val safeParseFn = "safeParse$templateShort"

        val format = template.format
        val emitExtractLenient = TemplateConstants.FORMAT_JSON.equals(format, ignoreCase = true)
            || TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — parser for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("import kotlinx.serialization.json.Json\n")
            if (emitExtractLenient) {
                append("import com.metaobjects.loader.MetaDataLoader\n")
                append("import com.metaobjects.`object`.extract.MetaObjectExtractor\n")
                append("import com.metaobjects.render.extract.Format\n")
                append("import com.metaobjects.render.extract.ExtractMap\n")
                append("import com.metaobjects.render.extract.ExtractOptions\n")
                append("import com.metaobjects.render.extract.ExtractionResult\n")
            }
            append("\n")
            if (emitExtractLenient) {
                // Nested-aware mirror: the root Extracted class + one mirror per reachable
                // nested value-object. Object fields are typed as the nested mirror (single)
                // or List<NestedExtracted>? (array-of-objects) so the runtime-delegating
                // extractLenient(loader, ...) overload can populate the full graph (FR-010 nested gap).
                append(KotlinExtractSchemaEmitter.extractedClassDeclsNested(payloadVo, extractedClass))
                append("\n\n")
            }
            append("/** Parser for LLM responses matching the `")
            append(templateShort)
            append("` template.output. */\n")
            append("object ")
            append(parserClass)
            append(" {\n")
            append("\n")
            append("    private val json: Json = Json { ignoreUnknownKeys = false }\n")
            append("\n")
            append("    /**\n")
            append("     * Parse an LLM response into a typed [")
            append(payloadClass)
            append("].\n")
            append("     *\n")
            append("     * @throws kotlinx.serialization.SerializationException when the input is not valid JSON for the payload schema.\n")
            append("     */\n")
            append("    fun ")
            append(parseFn)
            append("(text: String): ")
            append(payloadClass)
            append(" =\n")
            append("        json.decodeFromString<")
            append(payloadClass)
            append(">(text)\n")
            append("\n")
            append("    /**\n")
            append("     * Parse with explicit error handling (Result-style — does not throw).\n")
            append("     */\n")
            append("    fun ")
            append(safeParseFn)
            append("(text: String): Result<")
            append(payloadClass)
            append("> =\n")
            append("        runCatching { ")
            append(parseFn)
            append("(text) }\n")
            if (emitExtractLenient) {
                val formatEnum = if (TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true))
                    "Format.XML" else "Format.JSON"
                val payloadFqn = payloadVo.name

                // ---- Runtime-delegating extract (the single metadata-driven extract path) ----
                append("\n")
                append("    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */\n")
                append("    const val PAYLOAD_FQN: String = \"")
                append(KotlinExtractSchemaEmitter.kotlinStringLiteral(payloadFqn))
                append("\"\n")
                append("\n")
                append("    /**\n")
                append("     * Tolerant best-effort extraction delegating to the runtime MetaObjectExtractor;\n")
                append("     * never throws. Fully populates nested-object and array-of-object components by\n")
                append("     * reading the live metadata directly. Resolves this payload's\n")
                append("     * MetaObject by [PAYLOAD_FQN] from [loader].\n")
                append("     */\n")
                append("    fun extractLenient(loader: MetaDataLoader, text: String, opts: ExtractOptions = ExtractOptions.defaults()): ExtractionResult<")
                append(extractedClass)
                append("> {\n")
                append("        val mo = loader.getMetaObjectByName(PAYLOAD_FQN)\n")
                append("        val raw = MetaObjectExtractor.extract(mo, text, ")
                append(formatEnum)
                append(", opts)\n")
                append("        // The assembled graph is a ValueObject (a Map<String, Any?>) with nested\n")
                append("        // ValueObjects / List<ValueObject> — map it into the typed Extracted mirror graph.\n")
                append("        @Suppress(\"UNCHECKED_CAST\")\n")
                append("        val d = raw.data as? Map<String, Any?>\n")
                append("        return ExtractionResult(from")
                append(extractedClass)
                append("(d), raw.report)\n")
                append("    }\n")

                // ---- Generated ValueObject(Map) -> typed Extracted-mirror mappers (root + nested, deduped) ----
                append(KotlinExtractMapperEmitter.mapperMethods(payloadVo, extractedClass))
            }
            append("}\n")
        }

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$parserClass.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
    }

    /** Resolve a `@payloadRef` to its `object.value` (rejects entities — payloads must be VOs). */
    private fun resolveViewObject(loader: MetaDataLoader, ref: String): MetaObject? =
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
    override fun getSingleOutputFilename(md: MetaObject): String = "${md.name}.kt"

    companion object {
        private val LOG = LoggerFactory.getLogger(KotlinOutputParserGenerator::class.java)
    }
}
