package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.util.MetaDataUtil;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The ADR-0052 direction rule, in ONE place (Java port).
 *
 * <p>A template subtype's axis is DIRECTION: {@code template.output} renders outbound
 * (a document or an email) and generates no parser; the inbound half — the response
 * shape, the FR-010 response-format fragment, and the parser-on-receipt — belongs to a
 * {@code template.prompt} that declares {@code @responseRef}.
 *
 * <p>Every inbound generator calls through here rather than re-deriving "which templates
 * have a response". Call sites each deciding for themselves is exactly how the
 * pre-ADR-0052 tier drifted: {@link SpringOutputParserGenerator} applied NO format filter
 * to the parser FILE (so an email template got a Jackson {@code readValue} for text the
 * system had just rendered) while gating its tolerant {@code extractLenient} on
 * {@code @format}, and {@link SpringOutputPromptGenerator} applied a THIRD, different
 * {@code @format} gate — the format of the OUTBOUND body, which is not the format of the
 * reply.
 *
 * <p>Mirrors {@code server/typescript/packages/codegen-ts/src/templates/find-inbound.ts}
 * and {@code server/csharp/MetaObjects.Codegen/Generators/FindInbound.cs}.
 */
public final class FindInbound {

    private FindInbound() { /* no instances */ }

    /** What an inbound generator needs about one responding prompt. */
    public record InboundShape(
        /** The resolved response value-object — the shape a reply is parsed INTO. */
        MetaObject vo,
        /** The {@code @responseRef} string as authored (bare or fully-qualified). */
        String ref,
        /**
         * The syntax of the REPLY (ADR-0053) — never the template's {@code @format},
         * which is the syntax of the rendered prompt BODY. The two genuinely differ.
         */
        String format
    ) {}

    /**
     * Every {@code template.prompt} that declares a response shape, ordered by name.
     *
     * <p>The gate is {@code @responseRef} PRESENCE, not a format value: declaring a
     * response shape IS the request for a parser. Gating on {@code @format} was what let
     * a {@code text} template get a strict parser but no tolerant extract, and — because
     * {@code @format} defaults to {@code text} — would silently emit nothing at all after
     * the re-homing.
     *
     * <p>ADR-0039: {@code getChildren(..., true)} — resolving root scan; a template may
     * inherit {@code @responseRef} from an abstract base via {@code extends}, and shipped
     * fixtures rely on exactly that.
     */
    public static List<MetaTemplate> inboundTemplates(MetaDataLoader loader) {
        List<MetaTemplate> out = new ArrayList<>();
        for (MetaTemplate t : loader.getRoot().getChildren(MetaTemplate.class, true)) {
            if (responseRefOf(t) != null) out.add(t);
        }
        out.sort(Comparator.comparing(MetaTemplate::getName));
        return out;
    }

    /**
     * True iff {@code node} is a responding prompt whose {@code @responseRef} resolves.
     * The single predicate shared by the generator loops AND the api-docs builder, so
     * docs can never claim a symbol codegen suppressed.
     */
    public static boolean isInbound(com.metaobjects.MetaData node, MetaDataLoader loader) {
        return node instanceof MetaTemplate t && responseShape(loader, t) != null;
    }

    /**
     * Resolve a prompt's response value-object and reply syntax, or {@code null} when the
     * template declares no {@code @responseRef} or the ref does not resolve — callers skip
     * rather than throw, matching the pre-ADR-0052 contract for an unresolvable payload ref.
     */
    public static InboundShape responseShape(MetaDataLoader loader, MetaTemplate tmpl) {
        String ref = responseRefOf(tmpl);
        if (ref == null) return null;
        // ADR-0042/#228: resolve package-aware — a bare ref binds the template's OWN
        // package first, never a bare-tail/global scan that could bind the WRONG package's
        // same-short-named object. Enforces the SAME "must be an object.value" target rule
        // @payloadRef obeys, so the two refs cannot diverge on what counts as a legal target.
        MetaObject vo = SpringPayloadGenerator.resolveValueObject(
            loader, ref, MetaDataUtil.findPackageForMetaData(tmpl));
        if (vo == null) return null;
        return new InboundShape(vo, ref, responseFormatOf(tmpl));
    }

    /**
     * The authored {@code @responseRef} of a responding prompt, or {@code null}.
     *
     * <p>The subtype half of this test does not discriminate on its own —
     * {@code @responseRef} is prompt-only vocabulary the LOADER already enforces — but it
     * is kept because it is what makes the rule READ as the direction rule, and because a
     * future provider could register the attribute more widely.
     *
     * <p>ADR-0039: {@code getResponseRef()} reads through {@code getMetaAttr}, which
     * resolves via {@code extends}.
     */
    private static String responseRefOf(MetaTemplate t) {
        if (!TemplateConstants.SUBTYPE_PROMPT.equals(t.getSubType())) return null;
        if (!(t instanceof PromptTemplate p)) return null;
        String ref = p.getResponseRef();
        return (ref == null || ref.isEmpty()) ? null : ref;
    }

    /**
     * The declared reply syntax, defaulted per ADR-0053.
     *
     * <p>The default is {@code json} because that reproduces the trace helper's
     * pre-ADR-0053 fallback exactly (anything that was not {@code "xml"} was treated as
     * JSON), which is what makes the attribute's introduction behaviour-preserving rather
     * than a new policy.
     */
    public static String responseFormatOf(MetaTemplate tmpl) {
        String raw = (tmpl instanceof PromptTemplate p) ? p.getResponseFormat() : null;
        return TemplateConstants.RESPONSE_FORMAT_XML.equalsIgnoreCase(raw)
            ? TemplateConstants.RESPONSE_FORMAT_XML
            : TemplateConstants.RESPONSE_FORMAT_DEFAULT;
    }

    /**
     * True iff the reply is XML. The strict tier is JSON-ONLY by construction — its body
     * is Jackson's {@code readValue}, and there is no XML equivalent worth generating: not
     * because no XML reader exists ({@code com.metaobjects.render.extract} ships a
     * forgiving one) but because strict all-or-nothing semantics layered over a REPAIRING
     * parser is incoherent — it would throw or accept based on how much repair happened.
     * So an XML reply gets the tolerant extract and nothing strict.
     */
    public static boolean isXml(String responseFormat) {
        return TemplateConstants.RESPONSE_FORMAT_XML.equalsIgnoreCase(responseFormat);
    }
}
