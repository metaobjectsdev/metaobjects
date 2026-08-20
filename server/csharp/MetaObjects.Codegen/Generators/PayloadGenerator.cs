// payload-generator — for each `template.output` whose @payloadRef resolves to an
// object.value, emits a `<Payload>.payload.cs` file declaring the strict typed payload
// `record <PayloadRef>` (+ any nested element records) the prompt/parser/extractor bind to.
//
// This wraps the EXISTING PayloadCodegen.GeneratePayloadRecords logic (the single source
// of truth for the payload record shape) and wires it as a registered generator so the
// `record <Name>Payload` the output-parser/extractor REFERENCE is actually EMITTED by
// `dotnet meta gen`. Before this, PayloadCodegen was reachable only from VerifyCommand —
// the strict record was documented + referenced but never generated.
//
// The records are emitted under `namespace ctx.Config.Namespace` (the same namespace the
// output-parser / output-prompt / extractor generators emit under), so the references
// resolve in the consumer assembly.
//
// AppliesTo is the SINGLE SOURCE OF TRUTH the api-docs builder shares for the PAYLOAD
// symbol — a `template.output` whose `@payloadRef` resolves to a root-level
// `object.value` (the same gate RenderHelperGenerator.AppliesTo uses; the payload record
// name == the VO name).

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Core.Object.ObjectConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Emits one <c>&lt;Payload&gt;.payload.cs</c> per <c>template.output</c> whose
/// <c>@payloadRef</c> resolves to an <c>object.value</c>: the strict typed payload
/// <c>record &lt;PayloadRef&gt;</c> (+ nested element records) the prompt / parser /
/// extractor bind to. Wraps <see cref="PayloadCodegen"/> (the record-shape SSOT).
/// </summary>
public class PayloadGenerator : IGenerator
{
    public virtual string Name => "payload-generator";

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // EVERY template subtype (prompt / output / toolcall) carrying a @payloadRef, matching
        // Java, Kotlin and Python. C# alone filtered to template.output, so a template.prompt's
        // REQUEST shape — the payload a consumer constructs and hands to the render API — got no
        // record in this port. That is a real consumer surface, not dead output: the shipped
        // adopter docs show exactly this call for a prompt
        // (docs/features/templates-and-payloads.md:224, `new WelcomePromptPayload(...)` passed to
        // Renderer.render). The render HELPER is outbound-only in every port, which is what makes
        // this look unbound from inside codegen; the binding is hand-written by the adopter.
        //
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        var outbound = ctx.Root.Children()
            .Where(c => c.Type == TYPE_TEMPLATE)
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        var files = new List<EmittedFile>();
        // Dedupe by the resolved VO's FQN, not by template: the record is named after the
        // resolved VALUE-OBJECT, so two templates naming the same shape would otherwise emit the
        // same path twice and CodegenRunner would throw on the duplicate. Before ADR-0052 that
        // could only happen between two outputs sharing a @payloadRef; now an output's payload
        // and a prompt's response can legitimately be the same declared shape.
        var emittedVoFqns = new HashSet<string>(StringComparer.Ordinal);

        foreach (var tmpl in outbound)
        {
            if (!AppliesTo(tmpl, ctx.Root))
            {
                // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
                if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is null)
                    ctx.Warn($"{Name}: {tmpl.Type}.{tmpl.SubType} \"{tmpl.Name}\" missing @payloadRef — skipped.");
                continue;
            }
            var payloadRef = (string)tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF)!;
            AddIfNew(files, emittedVoFqns, tmpl, payloadRef, ctx);
        }

        // ADR-0052 — the INBOUND half. A responding prompt's `@responseRef` names the shape its
        // generated parser/extractor return, so that shape needs a strict record of its own. It
        // is NOT the prompt's `@payloadRef`, which types the request rendered outbound; emitting
        // only the request record would leave OutputParserGenerator referencing a type nobody
        // declares, and the generated code would not compile.
        foreach (var tmpl in FindInbound.InboundTemplates(ctx.Root))
        {
            if (FindInbound.ResponseShape(ctx.Root, tmpl) is not { } shape) continue;
            // AddIfNew re-resolves through ResolvePayloadVo, which enforces the SAME
            // "must be an object.value" target rule @payloadRef obeys — so the two refs cannot
            // diverge on what counts as a legal payload target.
            AddIfNew(files, emittedVoFqns, tmpl, shape.Ref, ctx);
        }

        return files;
    }

    /// <summary>Emit the payload record file for one ref unless its resolved VO already has one.</summary>
    private void AddIfNew(List<EmittedFile> files, HashSet<string> emittedVoFqns,
        MetaData tmpl, string reference, GenContext ctx)
    {
        var referrerPkg = global::MetaObjects.NamingRefs.EffectivePackage(tmpl);
        var vo = ResolvePayloadVo(ctx.Root, reference, referrerPkg);
        if (vo is null) return;
        if (!emittedVoFqns.Add(vo.ResolutionKey())) return;
        files.Add(EmitPayload(tmpl, reference, ctx));
    }

    /// <summary>
    /// True iff this generator emits a strict payload record for <paramref name="tmpl"/>: ANY
    /// <c>template.*</c> whose <c>@payloadRef</c> resolves to a root-level <c>object.value</c>.
    /// Single source of truth shared by the generator loop AND the api-docs builder (so docs
    /// never claim a payload record that is not emitted). Reuses the SAME resolver
    /// <see cref="RenderHelperGenerator.AppliesTo"/> uses (no mirror), but deliberately NOT its
    /// subtype filter: the render helper is outbound-only, while a payload record is wanted for
    /// any template a consumer renders — which includes a prompt.
    /// </summary>
    public static bool AppliesTo(MetaData tmpl, MetaRoot root)
    {
        if (tmpl.Type != TYPE_TEMPLATE) return false;
        // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
        if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef) return false;
        // ADR-0042: a bare @payloadRef resolves in the template's package.
        return RenderHelperGenerator.ResolveValueObject(
            root, payloadRef, global::MetaObjects.NamingRefs.EffectivePackage(tmpl)) is not null;
    }

    /// <summary>The <c>object.value</c> a <c>@payloadRef</c> names, or null. ADR-0042:
    /// package-local — <paramref name="referrerPkg"/> is the declaring template's package.</summary>
    internal static MetaData? ResolvePayloadVo(MetaRoot root, string payloadRef, string referrerPkg = "") =>
        RenderHelperGenerator.ResolveValueObject(root, payloadRef, referrerPkg);

    protected virtual EmittedFile EmitPayload(MetaData tmpl, string payloadRef, GenContext ctx)
    {
        // ADR-0042: a bare @payloadRef resolves in the template's own package — thread it
        // through so GeneratePayloadRecords resolves the SAME node AppliesTo already checked.
        var referrerPkg = global::MetaObjects.NamingRefs.EffectivePackage(tmpl);
        var records = PayloadCodegen.GeneratePayloadRecords(ctx.Root, payloadRef, referrerPkg);
        // ADR-0044: the file name is the resolved root VO's EMITTED (possibly package-
        // qualified) name — never the raw payloadRef, which leaks "::" into the path when
        // authored/resolved as an FQN.
        var rootName = PayloadCodegen.ResolveEmittedName(ctx.Root, payloadRef, referrerPkg)
            ?? CSharpNaming.StripPkg(payloadRef);

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects payload-generator. Do not edit by hand.");
        sb.AppendLine("// The strict typed payload record(s) the prompt / parser / extractor bind to.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.Append(records);
        return new EmittedFile($"{rootName}.payload.cs", sb.ToString());
    }
}
