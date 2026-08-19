// FindInbound — the ADR-0052 direction rule, in ONE place (C# port).
//
// A template subtype's axis is DIRECTION: `template.output` renders outbound (a
// document or an email) and generates no parser; the inbound half — the response
// shape, the FR-010 response-format fragment, and the parser-on-receipt — belongs
// to a `template.prompt` that declares `@responseRef`.
//
// Every inbound generator calls through here rather than re-deriving "which
// templates have a response". Three call sites each deciding for themselves is
// exactly how the pre-ADR-0052 tier drifted: OutputParserGenerator applied NO
// format filter at all (so an email template got a JSON parser for text the
// system had just rendered), while OutputPromptGenerator and ExtractorGenerator
// each applied their own json/xml gate against @format — the format of the
// OUTBOUND body, which is not the format of the reply.
//
// Mirrors server/typescript/packages/codegen-ts/src/templates/find-inbound.ts.

using System;
using System.Collections.Generic;
using System.Linq;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>What an inbound generator needs about one responding prompt.</summary>
/// <param name="Vo">The resolved response value-object — the shape a reply is parsed INTO.</param>
/// <param name="Ref">The <c>@responseRef</c> string as authored (bare or fully-qualified).</param>
/// <param name="Format">
/// The syntax of the REPLY (ADR-0053) — never the template's <c>@format</c>, which is the syntax of
/// the rendered prompt BODY. The two genuinely differ.
/// </param>
internal readonly record struct InboundShape(MetaData Vo, string Ref, string Format);

/// <summary>The single place the ADR-0052 "which templates are inbound" rule lives.</summary>
internal static class FindInbound
{
    /// <summary>
    /// Every <c>template.prompt</c> that declares a response shape, ordinal by name.
    ///
    /// The gate is <c>@responseRef</c> PRESENCE, not a format value: declaring a response shape IS
    /// the request for a parser. Gating on <c>@format</c> was what let a <c>text</c> template get a
    /// strict parser but no tolerant extract, and — because <c>@format</c> defaults to <c>text</c> —
    /// would silently emit nothing at all after the re-homing.
    ///
    /// ADR-0039: Children() — resolving root scan; a template may inherit <c>@responseRef</c> from an
    /// abstract base via <c>extends</c>, and shipped fixtures rely on exactly that.
    /// </summary>
    public static List<MetaData> InboundTemplates(MetaData root) =>
        root.Children()
            .Where(c => c.Type == TYPE_TEMPLATE
                        && c.SubType == TEMPLATE_SUBTYPE_PROMPT
                        && c.Attr(TEMPLATE_ATTR_RESPONSE_REF) is string)
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// True iff <paramref name="tmpl"/> is a responding prompt whose <c>@responseRef</c> resolves.
    /// The single predicate shared by the generator loops AND the api-docs builder, so docs can
    /// never claim a symbol codegen suppressed.
    /// </summary>
    public static bool IsInbound(MetaData tmpl, MetaData root) => ResponseShape(root, tmpl) is not null;

    /// <summary>
    /// Resolve a prompt's response value-object and reply syntax, or <c>null</c> when the template
    /// declares no <c>@responseRef</c> or the ref does not resolve — callers skip rather than throw,
    /// matching the pre-ADR-0052 contract for an unresolvable payload ref.
    /// </summary>
    public static InboundShape? ResponseShape(MetaData root, MetaData tmpl)
    {
        // ADR-0039: resolving — @responseRef may be inherited via an abstract template base.
        if (tmpl.Attr(TEMPLATE_ATTR_RESPONSE_REF) is not string reference) return null;
        // ADR-0042/#228: resolve package-aware — a bare ref binds the template's OWN package first,
        // never a bare-tail/global scan that could bind the WRONG package's same-short-named object.
        var referrerPkg = global::MetaObjects.NamingRefs.EffectivePackage(tmpl);
        var vo = global::MetaObjects.NamingRefs.ResolveObjectRef(root, reference, referrerPkg);
        if (vo is null) return null;
        return new InboundShape(vo, reference, ResponseFormatOf(tmpl));
    }

    /// <summary>
    /// The declared reply syntax, defaulted per ADR-0053.
    ///
    /// The default is <c>json</c> because that reproduces the trace helper's pre-ADR-0053 fallback
    /// exactly (anything that was not <c>"xml"</c> was treated as JSON), which is what makes the
    /// attribute's introduction behaviour-preserving rather than a new policy.
    /// </summary>
    public static string ResponseFormatOf(MetaData tmpl) =>
        // ADR-0039: resolving — @responseFormat may be inherited via an abstract template base.
        tmpl.Attr(TEMPLATE_ATTR_RESPONSE_FORMAT) is string f
        && f.Equals(RESPONSE_FORMAT_XML, StringComparison.OrdinalIgnoreCase)
            ? RESPONSE_FORMAT_XML
            : RESPONSE_FORMAT_DEFAULT;

    /// <summary>
    /// True iff the reply is XML. The strict tier is JSON-ONLY by construction — its body is
    /// <c>JsonSerializer.Deserialize&lt;T&gt;</c>, and there is no XML equivalent worth generating:
    /// not because no XML reader exists (MetaObjects.Render ships a forgiving one) but because
    /// strict all-or-nothing semantics layered over a REPAIRING parser is incoherent. So an XML
    /// reply gets the tolerant extract and nothing strict.
    /// </summary>
    public static bool IsXml(string responseFormat) =>
        responseFormat.Equals(RESPONSE_FORMAT_XML, StringComparison.OrdinalIgnoreCase);
}
