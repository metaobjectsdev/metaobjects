package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.PromptTemplate
import com.metaobjects.template.TemplateConstants

/**
 * The ADR-0052 direction rule, in ONE place (Kotlin port).
 *
 * A template subtype's axis is DIRECTION: `template.output` renders outbound (a document or
 * an email) and generates no parser; the inbound half — the response shape, the FR-010
 * response-format fragment, and the parser-on-receipt — belongs to a `template.prompt` that
 * declares `@responseRef`.
 *
 * Every inbound generator calls through here rather than re-deriving "which templates have a
 * response". Call sites each deciding for themselves is exactly how the pre-ADR-0052 tier
 * drifted: the parser applied no format filter to the parser FILE while gating its tolerant
 * extract on `@format`, and the fragment emitter applied a different `@format` gate — the
 * format of the OUTBOUND body, which is not the format of the reply.
 *
 * Mirrors `codegen-spring`'s `FindInbound.java`, C#'s `FindInbound.cs` and TypeScript's
 * `find-inbound.ts`. Kotlin needs its own copy because `codegen-kotlin` does not depend on
 * `codegen-spring`.
 */
object FindInbound {

    /**
     * What an inbound generator needs about one responding prompt.
     *
     * @property vo the resolved response value-object — the shape a reply is parsed INTO.
     * @property ref the `@responseRef` string as authored (bare or fully-qualified).
     * @property format the syntax of the REPLY (ADR-0053) — never the template's `@format`,
     *   which is the syntax of the rendered prompt BODY. The two genuinely differ.
     */
    data class InboundShape(val vo: MetaObject, val ref: String, val format: String)

    /**
     * Every `template.prompt` that declares a response shape, ordered by name.
     *
     * The gate is `@responseRef` PRESENCE, not a format value: declaring a response shape IS
     * the request for a parser. Gating on `@format` was what let a `text` template get a
     * strict parser but no tolerant extract, and — because `@format` defaults to `text` —
     * would silently emit nothing at all after the re-homing.
     *
     * ADR-0039: `getChildren(..., true)` — resolving root scan; a template may inherit
     * `@responseRef` from an abstract base via `extends`, and shipped fixtures rely on that.
     */
    @JvmStatic
    fun inboundTemplates(loader: MetaDataLoader): List<MetaTemplate> =
        loader.root.getChildren(MetaTemplate::class.java, true)
            .filter { responseRefOf(it) != null }
            .sortedBy { it.name }

    /**
     * True iff [node] is a responding prompt whose `@responseRef` resolves. The single
     * predicate shared by the generator loops AND the api-docs builder, so docs can never
     * claim a symbol codegen suppressed.
     */
    @JvmStatic
    fun isInbound(node: MetaData, loader: MetaDataLoader): Boolean =
        node is MetaTemplate && responseShape(loader, node) != null

    /**
     * Resolve a prompt's response value-object and reply syntax, or `null` when the template
     * declares no `@responseRef` or the ref does not resolve — callers skip rather than throw,
     * matching the pre-ADR-0052 contract for an unresolvable payload ref.
     */
    @JvmStatic
    fun responseShape(loader: MetaDataLoader, tmpl: MetaTemplate): InboundShape? {
        val ref = responseRefOf(tmpl) ?: return null
        // ADR-0042/#228: resolve package-aware through the SAME value-object resolver
        // @payloadRef obeys, so the parser can never bind a record the payload tier refused to
        // emit (the C# defect this port is written to avoid).
        val vo = KotlinGenUtil.resolveValueObjectRef(loader, ref, tmpl.getPackage()) ?: return null
        return InboundShape(vo, ref, responseFormatOf(tmpl))
    }

    /**
     * The authored `@responseRef` of a responding prompt, or `null`.
     *
     * ADR-0039: `getResponseRef()` reads through `getMetaAttr`, which resolves via `extends`.
     */
    private fun responseRefOf(t: MetaTemplate): String? {
        if (TemplateConstants.SUBTYPE_PROMPT != t.subType) return null
        val ref = (t as? PromptTemplate)?.responseRef
        return if (ref.isNullOrEmpty()) null else ref
    }

    /**
     * The declared reply syntax, defaulted per ADR-0053.
     *
     * The default is `json` because that reproduces the trace helper's pre-ADR-0053 fallback
     * exactly (anything that was not `"xml"` was treated as JSON), which is what makes the
     * attribute's introduction behaviour-preserving rather than a new policy.
     */
    @JvmStatic
    fun responseFormatOf(tmpl: MetaTemplate): String {
        val raw = (tmpl as? PromptTemplate)?.responseFormat
        return if (TemplateConstants.RESPONSE_FORMAT_XML.equals(raw, ignoreCase = true))
            TemplateConstants.RESPONSE_FORMAT_XML
        else
            TemplateConstants.RESPONSE_FORMAT_DEFAULT
    }

    /**
     * True iff the reply is XML. The strict tier is JSON-ONLY by construction — its body is
     * a Jackson `readValue`, and there is no XML equivalent worth generating: not because no
     * XML reader exists (`com.metaobjects.render.extract` ships a forgiving one) but because
     * strict all-or-nothing semantics layered over a REPAIRING parser is incoherent — it would
     * throw or accept based on how much repair happened. So an XML reply gets the tolerant
     * extract and nothing strict.
     */
    @JvmStatic
    fun isXml(responseFormat: String): Boolean =
        TemplateConstants.RESPONSE_FORMAT_XML.equals(responseFormat, ignoreCase = true)
}
