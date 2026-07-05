package com.metaobjects.generator.kotlin

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
import com.metaobjects.template.TemplateConstants
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one `<TemplateShortName>RenderHelper.kt` per `template.output`
 * declaration, wrapping the EXISTING JVM [com.metaobjects.render.Renderer] engine
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
 * `<PayloadType>` is the generated Kotlin payload data class
 * (`<TemplateShortName>Payload`, from [KotlinPayloadGenerator]) — referenced by its
 * same-package short name. `RenderRequest.payload` is `Object`, so the typed payload
 * binds directly.
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
        val outputs = loader.root.getChildren(OutputTemplate::class.java, true)
            .sortedBy { it.name }

        for (tmpl in outputs) {
            emit(tmpl, loader, outRoot, provider)
        }
    }

    protected open fun emit(template: MetaTemplate, loader: MetaDataLoader, outRoot: Path,
                     provider: FilesystemProvider) {
        val payloadRef = template.payloadRef
        if (payloadRef.isNullOrEmpty()) {
            return // loader validation normally catches this first
        }
        val payloadVo = resolveValueObject(loader, payloadRef) ?: return // not a VO

        val (templatePkg, templateShort) = PackageMapping.splitFqn(template.name)
        val outPkg = KotlinNaming.promptsPackage(templatePkg)
        val helperClass = KotlinNaming.renderHelperName(templateShort)
        // KotlinPayloadGenerator names the payload data class via KotlinNaming.payloadName
        // into the same <pkg>.prompts package — reference it through the SAME seam so this
        // name is byte-identical to what that generator emits (single source of truth).
        val payloadClass = KotlinNaming.payloadName(templateShort)

        // Payload field tree — reused by the build-time gate AND baked into the emitted
        // RenderRequest.verify so the runtime check matches the gate.
        val fields = derivePayloadFieldTree(loader, payloadVo, LinkedHashSet())
        val fieldTreeLiteral = fieldTreeLiteral(fields)

        val isEmail = TemplateConstants.KIND_EMAIL.equals(kindOf(template), ignoreCase = true)

        val body = StringBuilder()
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

            body.append("    fun render(payload: ").append(payloadClass)
                .append(", provider: com.metaobjects.render.Provider): com.metaobjects.render.EmailDocument {\n")
            body.append("        val r = com.metaobjects.render.Renderer()\n")
            body.append("        return com.metaobjects.render.EmailDocument(\n")
            body.append("            r.render(com.metaobjects.render.RenderRequest(\n")
                .append("                null, ").append(quote(subjectRef))
                .append(", payload, provider, \"text\",\n")
                .append("                ").append(fieldTreeLiteral).append(", null)),\n")
            body.append("            r.render(com.metaobjects.render.RenderRequest(\n")
                .append("                null, ").append(quote(htmlBodyRef))
                .append(", payload, provider, \"html\",\n")
                .append("                ").append(fieldTreeLiteral).append(", null)),\n")
            if (textBodyRef != null) {
                body.append("            r.render(com.metaobjects.render.RenderRequest(\n")
                    .append("                null, ").append(quote(textBodyRef))
                    .append(", payload, provider, \"text\",\n")
                    .append("                ").append(fieldTreeLiteral).append(", null)))\n")
            } else {
                body.append("            null)\n")
            }
            body.append("    }\n")
        } else {
            val textRef = attr(template, TemplateConstants.ATTR_TEXT_REF)
                ?: throw GeneratorException(
                    "template.output \"${template.name}\" (document) missing @textRef")
            val format = template.format
            val maxChars = template.maxChars

            // BUILD-TIME drift gate.
            gateRef(template.name, textRef, provider, fields)

            body.append("    fun render(payload: ").append(payloadClass)
                .append(", provider: com.metaobjects.render.Provider): String =\n")
            body.append("        com.metaobjects.render.Renderer().render(com.metaobjects.render.RenderRequest(\n")
            body.append("            null, ").append(quote(textRef)).append(", payload, provider, ")
                .append(quote(format)).append(",\n")
            body.append("            ").append(fieldTreeLiteral).append(", ")
                .append(maxChars?.toString() ?: "null").append("))\n")
        }

        val src = buildString {
            append("// GENERATED — DO NOT EDIT — render helper for template.output `")
            append(template.name)
            append("`\n")
            append("package ")
            append(outPkg)
            append("\n\n")
            append("/** Typed render helper for the `")
            append(templateShort)
            append("` template.output. Wraps the JVM render() engine; the payload field tree is\n")
            append(" *  baked into the RenderRequest so render()'s runtime drift check matches the\n")
            append(" *  build-time gate enforced when this file was generated. */\n")
            append("object ")
            append(helperClass)
            append(" {\n")
            append(body)
            append("}\n")
        }

        val outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve("$helperClass.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, src)
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
            if (field is ObjectField) {
                // Resolve the nested @objectRef by BARE short-name — the cross-port
                // render-helper consensus. Do NOT use the package-FOLDING resolver here;
                // the render-helper field-tree must resolve identically across all five ports.
                val target = resolveNestedObjectRef(loader, field)
                if (target != null && MetaObject.SUBTYPE_VALUE == target.subType) {
                    val children = derivePayloadFieldTree(loader, target, LinkedHashSet(seen))
                    fields.add(PayloadField.`object`(field.name, children))
                    continue
                }
            }
            fields.add(PayloadField.scalar(field.name))
        }
        return fields
    }

    /**
     * Resolve a `field.object`'s `@objectRef` to its target `object.value` by BARE
     * short-name — mirroring the cross-port render-helper consensus. The raw
     * `@objectRef` attr value is read directly (NOT package-folded); if it carries a
     * package, only the last `::` segment is compared, against each `object.value`'s
     * own short name. Returns null when the field has no `@objectRef` or no matching
     * `object.value` is found.
     */
    private fun resolveNestedObjectRef(loader: MetaDataLoader, field: ObjectField): MetaObject? {
        // ADR-0039: @objectRef is an inheritable effective field property — RESOLVE
        // (includeParentData=true) so a field.object inheriting @objectRef via extends
        // still resolves its target VO.
        if (!field.hasMetaAttr(MetaObject.ATTR_OBJECT_REF, true)) return null
        val ref = field.getMetaAttr(MetaObject.ATTR_OBJECT_REF, true).valueAsString
        if (ref.isNullOrEmpty()) return null
        // ADR-0041: a FULLY-QUALIFIED @objectRef (contains "::") resolves EXACTLY on the
        // value-object's package-qualified name — never a bare-tail fallback (the closed
        // bug: an FQN ref binding a same-named object.value in the WRONG package). A bare
        // ref matches the object.value's short name (the cross-port render-helper consensus).
        val fqn = ref.contains("::")
        for (obj in loader.metaObjects) {
            if (MetaObject.SUBTYPE_VALUE != obj.subType) continue
            val matches = if (fqn) obj.name == ref else obj.name.substringAfterLast("::") == ref
            if (matches) return obj
        }
        return null
    }

    /**
     * Emit a `List<PayloadField>` as deterministic Kotlin construction code
     * (`java.util.List.of(...)`): `PayloadField.scalar("name")` and
     * `PayloadField.object("nested", List.of(...))`. An empty tree emits
     * `java.util.List.of()`. `java.util.List.of` matches what `RenderRequest.verify`
     * (a `List<PayloadField>`) expects and mirrors the Java render-helper's literal.
     */
    private fun fieldTreeLiteral(fields: List<PayloadField>): String {
        if (fields.isEmpty()) return "java.util.List.of<com.metaobjects.render.PayloadField>()"
        val sb = StringBuilder("java.util.List.of(")
        for ((i, f) in fields.withIndex()) {
            if (i > 0) sb.append(", ")
            if (f.fields() != null) {
                sb.append("com.metaobjects.render.PayloadField.`object`(")
                  .append(quote(f.name())).append(", ")
                  .append(fieldTreeLiteral(f.fields())).append(")")
            } else {
                sb.append("com.metaobjects.render.PayloadField.scalar(")
                  .append(quote(f.name())).append(")")
            }
        }
        sb.append(")")
        return sb.toString()
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

    /** Resolve a `@payloadRef` to its `object.value` (rejects entities — payloads must be VOs). */
    private fun resolveValueObject(loader: MetaDataLoader, ref: String): MetaObject? =
        KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref)
            ?.takeIf { it.subType == MetaObject.SUBTYPE_VALUE }

    /** Kotlin string-literal quoting with the common escapes. */
    private fun quote(s: String?): String {
        if (s == null) return "null"
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '$' -> sb.append("\\$")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
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
    override fun getSingleOutputFilename(md: MetaObject): String =
        "${KotlinNaming.renderHelperName(PackageMapping.splitFqn(md.name).second)}.kt"

    companion object {
        /** Arg key for the on-disk template dir used by the build-time drift gate. */
        const val ARG_TEMPLATE_ROOT: String = "templateRoot"
    }
}
