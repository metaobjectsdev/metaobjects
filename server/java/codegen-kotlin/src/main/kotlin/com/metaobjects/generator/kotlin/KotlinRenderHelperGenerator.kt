package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.generator.kotlin.writer.KotlinWriter
import com.metaobjects.generator.writer.CodeWriter
import com.metaobjects.generator.writer.Group

import com.metaobjects.field.ObjectField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.render.FilesystemProvider
import com.metaobjects.render.PayloadField
import com.metaobjects.render.Verify
import com.metaobjects.render.VerifyOptions
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.PromptTemplate
import com.metaobjects.template.TemplateConstants
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import com.metaobjects.generator.util.GeneratedFileWriter

/**
 * Generator: one `<TemplateShortName>RenderHelper.kt` per RENDERABLE template
 * declaration — `template.output` AND `template.prompt`, since both render an outbound
 * body (ADR-0052) — wrapping the EXISTING JVM [com.metaobjects.render.Renderer] engine
 * (Kotlin reuses the shared JVM render lib) with a typed `render(payload, provider)`
 * entry point — and enforcing the mustache↔VO drift check ([Verify]) at BUILD time.
 *
 * The Kotlin port of the cross-port render-helper (`SpringRenderHelperGenerator`
 * (Java/reference) + the TS/C#/Python siblings). The emitted Kotlin source calls
 * the JVM render types by FQN; no Kotlin render engine is introduced.
 *
 * Two shapes keyed off `@kind`:
 *  - `document` (default) → renders `@textRef` in `@format` to a single `String`.
 *  - `email` → renders `@subjectRef` (text) + `@htmlBodyRef` (html) (+ optional
 *    `@textBodyRef`, text) into a [com.metaobjects.render.EmailDocument].
 *
 * **The headline is the BUILD-TIME drift gate.** BEFORE emitting, every referenced
 * mustache (`document`: `@textRef`; `email`: subject + html (+ optional text)
 * part-refs) is resolved through a [FilesystemProvider] rooted at the `templateRoot`
 * arg and run through [Verify.check]. If a referenced text is unresolvable OR carries
 * any NON-warning error (anything other than [Verify.ERR_REQUIRED_SLOT_UNUSED] — a
 * `{{field}}` not on the payload VO produces `ERR_VAR_NOT_ON_PAYLOAD`), this THROWS a
 * [GeneratorException] and FAILS codegen, naming the template, the ref, the error
 * code, and the offending field. The drift message style matches the other ports:
 * `render-helper drift: template "<Name>" ref "<ref>" — <CODE>: {{<field>}} not on payload VO`.
 *
 * The same payload [PayloadField] tree drives the build-time gate AND is baked into
 * the emitted `RenderRequest.verify` argument so the engine's runtime drift check
 * matches the gate that ran when the file was generated.
 *
 * `<PayloadType>` is the `@payloadRef` value object's own data class, emitted by
 * [KotlinEntityGenerator] in the value object's package (ADR-0056) and referenced fully
 * qualified. **Requires [KotlinEntityGenerator] in the same run.** `RenderRequest.payload` is
 * `Object`, so the typed payload binds directly.
 *
 * Skips (same contract as the other output generators): missing `@payloadRef`, or a
 * `@payloadRef` that doesn't resolve to an `object.value`.
 *
 * Args:
 *  - `outputDir` (required): output directory root.
 *  - `templateRoot` (required): on-disk template dir the build-time drift gate
 *    resolves each referenced mustache against.
 */
open class KotlinRenderHelperGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    /** The template root is an input (ADR-0064): editing a template regenerates. */
    override fun extraInputs(): List<String> =
        if (hasArg(ARG_TEMPLATE_ROOT)) listOf(getArg(ARG_TEMPLATE_ROOT)) else emptyList()

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        val templateRoot = getArg(ARG_TEMPLATE_ROOT, false)
        if (templateRoot.isNullOrEmpty()) {
            throw GeneratorException(
                "KotlinRenderHelperGenerator requires the '$ARG_TEMPLATE_ROOT' arg " +
                    "(the on-disk template dir) for the build-time drift gate"
            )
        }
        val provider = FilesystemProvider(Paths.get(templateRoot))

        // Stable name order — matches the other ports' deterministic emission.
        // ADR-0039: root-scan discipline — resolving children accessor.
        //
        // BOTH renderable subtypes: ADR-0052 makes the template axis DIRECTION, and a
        // PromptTemplate renders an outbound body exactly as an OutputTemplate does —
        // only what comes back differs, and that inbound tier belongs to the parser and
        // output-prompt generators. Collecting OutputTemplate alone left a
        // template.prompt with no generated render helper on this port at all.
        val renderable: List<MetaTemplate> =
            (loader.root.getChildren(OutputTemplate::class.java, true).toList() +
                loader.root.getChildren(PromptTemplate::class.java, true).toList())
                .sortedBy { it.name }

        for (tmpl in renderable) {
            emit(tmpl, loader, outRoot, provider)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path,
                     provider: FilesystemProvider) {
        val payloadRef = template.payloadRef
        if (payloadRef.isNullOrEmpty()) {
            return // loader validation normally catches this first
        }
        val payloadVo = KotlinGenUtil.payloadTarget(template, "payloadRef")
            ?: return // not a VO

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val helperClass = KotlinNaming.renderHelperName(templateShort)
        // ADR-0056 — the payload IS the @payloadRef value object's own data class, the one
        // KotlinEntityGenerator emits in the value object's package. Referenced fully qualified;
        // this generator declares no payload type of its own.
        KotlinNaming.requireReferenceable(outPkg, payloadVo, "template '${template.name}'")
        val payloadClass = KotlinNaming.strictRef(payloadVo)

        // Payload field tree — reused by the build-time gate AND baked into the emitted
        // RenderRequest.verify so the runtime check matches the gate.
        val fields = derivePayloadFieldTree(loader, payloadVo, LinkedHashSet())
        val fieldTree = fieldTreeLiteral(fields)

        val isEmail = TemplateConstants.KIND_EMAIL.equals(kindOf(template), ignoreCase = true)

        val w = KotlinWriter().packageName(outPkg)
        w.header("// GENERATED — DO NOT EDIT — render helper for template.${template.subType} `${template.name}`")
        w.doc(
            "Typed render helper for the `$templateShort` template.${template.subType}. Wraps the JVM render() engine; the payload field tree is",
            "baked into the RenderRequest so render()'s runtime drift check matches the",
            "build-time gate enforced when this file was generated.",
        )
        w.block("object $helperClass {") {
            if (isEmail) {
                val subjectRef = attr(template, TemplateConstants.ATTR_SUBJECT_REF)
                    ?: throw GeneratorException(
                        "template.output \"${template.name}\" (email) missing @subjectRef")
                val htmlBodyRef = attr(template, TemplateConstants.ATTR_HTML_BODY_REF)
                    ?: throw GeneratorException(
                        "template.output \"${template.name}\" (email) missing @htmlBodyRef")
                val textBodyRef = attr(template, TemplateConstants.ATTR_TEXT_BODY_REF)

                // BUILD-TIME drift gate — every email part-ref is resolved + verified.
                gateRef(template.name, subjectRef, provider, fields)
                gateRef(template.name, htmlBodyRef, provider, fields)
                if (textBodyRef != null) gateRef(template.name, textBodyRef, provider, fields)

                // One `r.render(RenderRequest(...))` per part; an absent text part is `null`.
                fun part(ref: String, format: String): Group = CodeWriter.list(
                    "r.render($RENDER.RenderRequest(",
                    listOf("null", quote(ref), "payload", "provider", quote(format), fieldTree, "null"),
                    "))",
                )
                w.block("fun render(payload: $payloadClass, provider: $RENDER.Provider): $RENDER.EmailDocument {") {
                    w.line("val r = $RENDER.Renderer()")
                    w.line(
                        "return ",
                        KotlinWriter.call(
                            "$RENDER.EmailDocument",
                            part(subjectRef, "text"),
                            part(htmlBodyRef, "html"),
                            if (textBodyRef != null) part(textBodyRef, "text") else "null",
                        ),
                    )
                }
            } else {
                val textRef = attr(template, TemplateConstants.ATTR_TEXT_REF)
                    ?: throw GeneratorException(
                        "template.${template.subType} \"${template.name}\" missing @textRef")
                val format = template.format
                val maxChars = template.maxChars

                // BUILD-TIME drift gate.
                gateRef(template.name, textRef, provider, fields)

                w.line("fun render(payload: $payloadClass, provider: $RENDER.Provider): String =")
                w.indented {
                    w.line(
                        CodeWriter.list(
                            "$RENDER.Renderer().render($RENDER.RenderRequest(",
                            listOf("null", quote(textRef), "payload", "provider", quote(format), fieldTree, maxChars?.toString() ?: "null"),
                            "))",
                        ),
                    )
                }
            }
        }
        val src = w.toString()

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$helperClass.kt")
        GeneratedFileWriter.write(outFile, src)
    }

    // -------------------------------------------------------------------------
    // Build-time drift gate
    // -------------------------------------------------------------------------

    /**
     * Run the build-time drift gate for one referenced mustache. Throws a
     * [GeneratorException] (fails codegen) when the ref is unresolvable OR
     * [Verify.check] reports a non-warning error. Warnings
     * ([Verify.ERR_REQUIRED_SLOT_UNUSED]) are tolerated. Matches the cross-port
     * drift message style exactly.
     */
    private fun gateRef(templateName: String, ref: String,
                        provider: FilesystemProvider, fields: List<PayloadField>) {
        val text = provider.resolve(ref)
            ?: throw GeneratorException(
                "render-helper drift: template \"$templateName\" ref \"$ref\" " +
                    "— unresolved (provider returned no text)")
        val opts = VerifyOptions(provider, null, null)
        for (e in Verify.check(text, fields, opts)) {
            if (Verify.ERR_REQUIRED_SLOT_UNUSED == e.code()) continue // warning
            throw GeneratorException(
                "render-helper drift: template \"$templateName\" ref \"$ref\" " +
                    "— ${e.code()}: {{${e.path()}}} not on payload VO")
        }
    }

    // -------------------------------------------------------------------------
    // Payload field-tree walk (mirrors SpringRenderHelperGenerator.derivePayloadFieldTree
    // + the TS derivePayloadFieldTree). Object-ref fields recurse by BARE short-name;
    // a `seen` set guards reference cycles. Recurse only into object.value (SUBTYPE_VALUE).
    // -------------------------------------------------------------------------

    private fun derivePayloadFieldTree(
        loader: MetaDataLoader, vo: MetaObject, seen: MutableSet<String>
    ): List<PayloadField> {
        if (seen.contains(vo.name)) return emptyList()
        seen.add(vo.name)
        val fields = ArrayList<PayloadField>()
        for (field in vo.metaFields) {
            // ADR-0039: isArrayType() is the EFFECTIVE (inherited-via-extends) array-ness; the
            // own-only isArray flag would read false for a field that inherits @isArray.
            val isArray = field.isArrayType
            if (field is ObjectField) {
                // Resolve the nested @objectRef by BARE short-name — the cross-port
                // render-helper consensus. Do NOT use the package-FOLDING resolver here;
                // the render-helper field-tree must resolve identically across all five ports.
                val target = resolveNestedObjectRef(loader, field)
                if (target != null && MetaObject.SUBTYPE_VALUE == target.subType) {
                    val children = derivePayloadFieldTree(loader, target, LinkedHashSet(seen))
                    fields.add(PayloadField.`object`(field.name, children, isArray))
                    continue
                }
            }
            fields.add(PayloadField.scalar(field.name, isArray))
        }
        return fields
    }

    /**
     * The `object.value` a `field.object`'s `@objectRef` is bound to (ADR-0059 R7: the
     * target the loader recorded, resolved in the package of the node that declared it).
     * Returns null when the field has no `@objectRef` or it names no `object.value`.
     */
    private fun resolveNestedObjectRef(loader: MetaDataLoader, field: ObjectField): MetaObject? {
        // ADR-0059 R7: read the target the loader bound for the declaring field's @objectRef
        // (resolved where it was written, so an inherited field.object binds its own package).
        val target = com.metaobjects.loader.References.refTarget(field, MetaObject.ATTR_OBJECT_REF)
        return if (target != null && MetaObject.SUBTYPE_VALUE == target.subType) target else null
    }

    /**
     * Emit a `List<PayloadField>` as deterministic Kotlin construction code
     * (`java.util.List.of(...)`): `PayloadField.scalar("name")` and
     * `PayloadField.object("nested", List.of(...))`. An empty tree emits
     * `java.util.List.of()`. `java.util.List.of` matches what `RenderRequest.verify`
     * (a `List<PayloadField>`) expects and mirrors the Java render-helper's literal.
     */
    private fun fieldTreeLiteral(fields: List<PayloadField>): Any {
        if (fields.isEmpty()) return "java.util.List.of<$RENDER.PayloadField>()"
        return KotlinWriter.call(
            "java.util.List.of",
            *fields.map { f ->
                val array = if (f.isArray()) listOf("true") else emptyList()
                if (f.fields() != null) {
                    KotlinWriter.call("$RENDER.PayloadField.`object`", quote(f.name()), fieldTreeLiteral(f.fields()), *array.toTypedArray())
                } else {
                    KotlinWriter.call("$RENDER.PayloadField.scalar", quote(f.name()), *array.toTypedArray())
                }
            }.toTypedArray(),
        )
    }

    // -------------------------------------------------------------------------
    // Local helpers
    // -------------------------------------------------------------------------

    // ADR-0039: template.* attrs RESOLVE through extends (includeParentData=true, the
    // default) — a template is a registered type that can be an `extends` target, so its
    // refs inherit. Matches the TS reference + C#.

    /** Resolve `@kind` (RESOLVING attr — ADR-0039), defaulting to `document`. */
    private fun kindOf(template: MetaTemplate): String {
        if (template is OutputTemplate && template.hasMetaAttr(TemplateConstants.ATTR_KIND)) {
            val v = template.getMetaAttr(TemplateConstants.ATTR_KIND).valueAsString
            if (!v.isNullOrEmpty()) return v
        }
        return TemplateConstants.KIND_DEFAULT
    }

    /** Read a template attr value (RESOLVING — ADR-0039), or null if absent. */
    private fun attr(template: MetaTemplate, attr: String): String? =
        if (template.hasMetaAttr(attr))
            template.getMetaAttr(attr).valueAsString
        else null

    /** A Kotlin string literal for [s], or `null`. */
    private fun quote(s: String?): String = if (s == null) "null" else KotlinWriter.str(s)

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
    override fun getSingleOutputFilename(md: MetaObject): String =
        "${KotlinNaming.renderHelperName(PackageMapping.splitFqn(md.name).second)}.kt"

    companion object {
        /** The render engine's package, which the helper names fully qualified. */
        private const val RENDER: String = "com.metaobjects.render"

        /** Arg key for the on-disk template dir used by the build-time drift gate. */
        const val ARG_TEMPLATE_ROOT: String = "templateRoot"
    }
}
