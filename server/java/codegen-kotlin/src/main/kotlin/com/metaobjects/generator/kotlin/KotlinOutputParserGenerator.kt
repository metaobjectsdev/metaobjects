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
class KotlinOutputParserGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

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

    private fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path) {
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
        val recoveredClass = templateShort + "Recovered"
        val parseFn = "parse$templateShort"
        val safeParseFn = "safeParse$templateShort"

        val format = template.format
        val emitRecover = TemplateConstants.FORMAT_JSON.equals(format, ignoreCase = true)
            || TemplateConstants.FORMAT_XML.equals(format, ignoreCase = true)

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — parser for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("import kotlinx.serialization.json.Json\n")
            if (emitRecover) {
                append("import com.metaobjects.render.recover.FieldKind\n")
                append("import com.metaobjects.render.recover.FieldSpec\n")
                append("import com.metaobjects.render.recover.Format\n")
                append("import com.metaobjects.render.recover.Recover\n")
                append("import com.metaobjects.render.recover.RecoverMap\n")
                append("import com.metaobjects.render.recover.RecoverOptions\n")
                append("import com.metaobjects.render.recover.RecoverSchema\n")
                append("import com.metaobjects.render.recover.RecoveryResult\n")
            }
            append("\n")
            if (emitRecover) {
                append(KotlinRecoverSchemaEmitter.recoveredClassDecl(payloadVo, recoveredClass))
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
            if (emitRecover) {
                append("\n")
                append("    private val RECOVER_SCHEMA: RecoverSchema =\n")
                append("        ")
                append(KotlinRecoverSchemaEmitter.schemaLiteral(payloadVo, format, payloadClass))
                append("\n")
            }
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
            if (emitRecover) {
                val ctorArgs = KotlinRecoverSchemaEmitter.recoveredCtorArgs(payloadVo)
                append("\n")
                append("    /** Tolerant best-effort recovery; never throws. Components are null where lost/malformed. */\n")
                append("    fun recover(text: String): RecoveryResult<")
                append(recoveredClass)
                append("> =\n")
                append("        recover(text, RecoverOptions.defaults())\n")
                append("\n")
                append("    fun recover(text: String, opts: RecoverOptions): RecoveryResult<")
                append(recoveredClass)
                append("> {\n")
                append("        val o = Recover.recover(text, RECOVER_SCHEMA, opts)\n")
                append("        val d = o.data\n")
                append("        return RecoveryResult(")
                append(recoveredClass)
                append("(")
                append(ctorArgs)
                append("), o.report)\n")
                append("    }\n")
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
