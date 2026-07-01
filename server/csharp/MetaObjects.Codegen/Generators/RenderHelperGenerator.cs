// render-helper-generator — for each `template.output` declaration, emits a
// `<TemplateName>.render.cs` file declaring a static `<TemplateName>RenderHelper`
// class with a typed `Render(payload, provider)` entry point that wraps the
// EXISTING MetaObjects.Render `Renderer.Render(...)` engine — AND enforces the
// mustache↔payload-VO drift check (the EXISTING `Verify.Check`) at BUILD time.
//
// Two shapes keyed off @kind:
//   • document (default) → renders @textRef in @format → one string.
//   • email              → renders @subjectRef (text) + @htmlBodyRef (html)
//                           (+ optional @textBodyRef, text) → an EmailDocument.
//
// THE HEADLINE is the BUILD-TIME drift gate. BEFORE emitting, every referenced
// mustache (document: @textRef; email: subject + html (+ optional text) part-refs)
// is resolved through a FilesystemProvider rooted at the templateRoot ctor arg and
// run through Verify.Check. If a referenced text is unresolvable OR carries any
// NON-warning error (i.e. anything other than ERR_REQUIRED_SLOT_UNUSED — a
// `{{field}}` not on the payload VO produces ERR_VAR_NOT_ON_PAYLOAD), this THROWS
// (fails codegen), naming the template, the ref, the error code, and the offending
// field. This is what makes the build fail when a mustache references a field the
// payload VO doesn't declare.
//
// Reuse, not reimplementation: Renderer.Render (the emitted runtime call), Verify
// (the build-time gate), FilesystemProvider (build-time ref resolution), and
// EmailDocument (email return type). The payload field tree is walked from the VO
// the same way the other generators walk it — but a nested field.object's
// @objectRef is resolved by BARE short-name (cross-port render-helper consensus:
// TS findObject / Java resolveNestedObjectRef), only recursing into object.value
// (SUBTYPE_VALUE) targets, cycle-guarded.
//
// The emitted <fieldTree> literal is baked into the RenderRequest.Verify argument
// so Renderer's runtime drift check matches the build-time gate that ran here.
//
// Skips (same contract as OutputParserGenerator / OutputPromptGenerator): missing
// @payloadRef, or a @payloadRef that doesn't resolve to an object.value.
//
// Mirrors the TS port (render-helper-file.ts + templates/render-helper.ts) and the
// Java port (SpringRenderHelperGenerator). The drift message style matches exactly:
//   render-helper drift: template "<Name>" ref "<ref>" — <CODE>: {{<field>}} not on payload VO

using System.Text;
using MetaObjects.Meta;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Object.ObjectConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Emits one <c>&lt;Template&gt;RenderHelper</c> class per <c>template.output</c>,
/// wrapping <see cref="Renderer"/> with a typed <c>Render(payload, provider)</c>
/// entry point and enforcing the mustache↔VO drift check (<see cref="Verify"/>) at
/// BUILD time. Construct with the on-disk template root the drift gate resolves each
/// referenced mustache against.
/// </summary>
public class RenderHelperGenerator : IGenerator
{
    /// <summary>
    /// The on-disk template resolver the build-time drift gate runs each referenced
    /// mustache through. <c>protected</c> so a subclass overriding <see cref="EmitHelper"/>
    /// (or the gate) can reuse the same provider.
    /// </summary>
    protected readonly FilesystemProvider _provider;

    /// <param name="templateRoot">
    /// On-disk template dir the build-time drift gate resolves each referenced
    /// mustache against (the same texts <see cref="Renderer"/> will resolve at
    /// runtime). Required — without it the drift gate cannot run.
    /// </param>
    public RenderHelperGenerator(string templateRoot)
    {
        if (string.IsNullOrEmpty(templateRoot))
            throw new ArgumentException(
                "RenderHelperGenerator requires a templateRoot (the on-disk template dir) for the build-time drift gate",
                nameof(templateRoot));
        _provider = new FilesystemProvider(templateRoot);
    }

    public virtual string Name => "render-helper-generator";

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        var outputs = ctx.Root.Children()
            .Where(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_OUTPUT)
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        var files = new List<EmittedFile>();
        foreach (var tmpl in outputs)
        {
            // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
            if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef)
            {
                ctx.Warn($"{Name}: template.output \"{tmpl.Name}\" missing @payloadRef — skipped.");
                continue;
            }
            // @payloadRef must resolve to an object.value (same contract as the
            // parser/prompt generators). The VO record name == payloadRef (PayloadCodegen).
            var vo = ResolveValueObject(ctx.Root, payloadRef);
            if (vo is null) continue;

            // EmitHelper runs the build-time drift gate first and THROWS (fails
            // codegen) on a mustache↔VO drift — intentionally NOT caught.
            files.Add(EmitHelper(tmpl, vo, payloadRef, ctx));
        }
        return files;
    }

    /// <summary>The root-level <c>object.value</c> a <c>@payloadRef</c> names, or null.</summary>
    internal static MetaData? ResolveValueObject(MetaRoot root, string payloadRef) =>
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        root.Children().FirstOrDefault(c =>
            c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_VALUE && c.Name == payloadRef);

    /// <summary>
    /// True iff this generator emits a render helper for <paramref name="tmpl"/>: a
    /// <c>template.output</c> whose <c>@payloadRef</c> resolves to a root-level
    /// <c>object.value</c>. Single source of truth shared by the generator loop AND the
    /// api-docs builder (so docs never claim a suppressed symbol).
    /// </summary>
    public static bool AppliesTo(MetaData tmpl, MetaRoot root)
    {
        if (tmpl.Type != TYPE_TEMPLATE || tmpl.SubType != TEMPLATE_SUBTYPE_OUTPUT) return false;
        // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
        if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef) return false;
        return ResolveValueObject(root, payloadRef) is not null;
    }

    protected virtual EmittedFile EmitHelper(MetaData tmpl, MetaData vo, string payloadRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var helperClass = CSharpNaming.RenderHelperName(templateName);
        var payloadType = payloadRef; // PayloadCodegen names the record after the VO name.

        // Payload field tree — reused by the build-time gate AND baked into the
        // emitted RenderRequest.Verify so the runtime check matches the gate.
        var fields = DerivePayloadFieldTree(ctx.Root, vo, new HashSet<string>(StringComparer.Ordinal));
        var ft = FieldTreeLiteral(fields);

        // ADR-0039: resolving — @kind may be inherited via an abstract template base.
        var kind = (tmpl.Attr(TEMPLATE_ATTR_KIND) as string ?? TEMPLATE_KIND_DEFAULT).ToLowerInvariant();

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects render-helper-generator. Do not edit by hand.");
        sb.AppendLine("// Typed render helper wrapping the render engine; the payload field tree is");
        sb.AppendLine("// baked into the RenderRequest so the runtime drift check matches the build-time gate.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"/// <summary>Typed render helper for the <c>{templateName}</c> template.output.</summary>");
        sb.AppendLine($"public static class {helperClass}");
        sb.AppendLine("{");

        if (kind == TEMPLATE_KIND_EMAIL)
        {
            // ADR-0039: resolving — email part-refs may be inherited via an abstract template base.
            var subjectRef = tmpl.Attr(TEMPLATE_ATTR_SUBJECT_REF) as string;
            var htmlBodyRef = tmpl.Attr(TEMPLATE_ATTR_HTML_BODY_REF) as string;
            var textBodyRef = tmpl.Attr(TEMPLATE_ATTR_TEXT_BODY_REF) as string;
            if (subjectRef is null)
                throw new InvalidOperationException($"template.output \"{templateName}\" (email) missing @subjectRef");
            if (htmlBodyRef is null)
                throw new InvalidOperationException($"template.output \"{templateName}\" (email) missing @htmlBodyRef");

            // BUILD-TIME drift gate — every email part-ref is resolved + verified.
            GateRef(templateName, subjectRef, fields);
            GateRef(templateName, htmlBodyRef, fields);
            if (textBodyRef is not null) GateRef(templateName, textBodyRef, fields);

            sb.AppendLine($"    /// <summary>Render the {templateName} email (subject + html body{(textBodyRef is not null ? " + text body" : "")}) from a typed {payloadType} payload.</summary>");
            sb.AppendLine($"    public static global::MetaObjects.Render.EmailDocument Render({payloadType} payload, global::MetaObjects.Render.IProvider provider) =>");
            sb.AppendLine("        new global::MetaObjects.Render.EmailDocument(");
            sb.AppendLine($"            global::MetaObjects.Render.Renderer.Render(new global::MetaObjects.Render.RenderRequest {{ Ref = {Quote(subjectRef)}, Payload = payload, Provider = provider, Format = \"text\", Verify = {ft} }}),");
            sb.Append($"            global::MetaObjects.Render.Renderer.Render(new global::MetaObjects.Render.RenderRequest {{ Ref = {Quote(htmlBodyRef)}, Payload = payload, Provider = provider, Format = \"html\", Verify = {ft} }})");
            sb.AppendLine(",");
            if (textBodyRef is not null)
                sb.AppendLine($"            global::MetaObjects.Render.Renderer.Render(new global::MetaObjects.Render.RenderRequest {{ Ref = {Quote(textBodyRef)}, Payload = payload, Provider = provider, Format = \"text\", Verify = {ft} }}));");
            else
                sb.AppendLine("            null);");
        }
        else
        {
            // ADR-0039: resolving — @textRef/@format may be inherited via an abstract template base.
            var textRef = tmpl.Attr(TEMPLATE_ATTR_TEXT_REF) as string;
            if (textRef is null)
                throw new InvalidOperationException($"template.output \"{templateName}\" (document) missing @textRef");
            var format = tmpl.Attr(TEMPLATE_ATTR_FORMAT) as string ?? TEMPLATE_FORMAT_DEFAULT;
            var maxChars = MaxCharsOf(tmpl);

            // BUILD-TIME drift gate.
            GateRef(templateName, textRef, fields);

            var maxCharsArg = maxChars is not null ? $", MaxChars = {maxChars}" : "";
            sb.AppendLine($"    /// <summary>Render the {templateName} document from a typed {payloadType} payload.</summary>");
            sb.AppendLine($"    public static string Render({payloadType} payload, global::MetaObjects.Render.IProvider provider) =>");
            sb.AppendLine($"        global::MetaObjects.Render.Renderer.Render(new global::MetaObjects.Render.RenderRequest {{ Ref = {Quote(textRef)}, Payload = payload, Provider = provider, Format = {Quote(format)}, Verify = {ft}{maxCharsArg} }});");
        }

        sb.AppendLine("}");
        return new EmittedFile($"{templateName}.render.cs", sb.ToString());
    }

    // -------------------------------------------------------------------------
    // Build-time drift gate
    // -------------------------------------------------------------------------

    /// <summary>
    /// Run the build-time drift gate for one referenced mustache. THROWS (fails
    /// codegen) when the ref is unresolvable OR <see cref="Verify.Check"/> reports a
    /// non-warning error. Warnings (<see cref="Verify.ERR_REQUIRED_SLOT_UNUSED"/>)
    /// are tolerated. Matches the TS/Java message style exactly.
    /// </summary>
    private void GateRef(string templateName, string reference, IReadOnlyList<PayloadField> fields)
    {
        var text = _provider.Resolve(reference);
        if (text is null)
            throw new InvalidOperationException(
                $"render-helper drift: template \"{templateName}\" ref \"{reference}\" — unresolved (provider returned no text)");

        var opts = new VerifyOptions { Provider = _provider };
        foreach (var e in Verify.Check(text, fields, opts))
        {
            if (e.Code == Verify.ERR_REQUIRED_SLOT_UNUSED) continue; // warning
            throw new InvalidOperationException(
                $"render-helper drift: template \"{templateName}\" ref \"{reference}\" — {e.Code}: {{{{{e.Path}}}}} not on payload VO");
        }
    }

    // -------------------------------------------------------------------------
    // Payload field-tree walk — nested @objectRef resolved by BARE short-name
    // (cross-port render-helper consensus: TS findObject / Java
    // resolveNestedObjectRef). Object-ref fields recurse into their target
    // object.value (SUBTYPE_VALUE only); a `seen` set guards reference cycles.
    // -------------------------------------------------------------------------

    private static IReadOnlyList<PayloadField> DerivePayloadFieldTree(
        MetaRoot root, MetaData vo, HashSet<string> seen)
    {
        if (vo is null || !seen.Add(vo.Name)) return [];
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            if (f.SubType == FIELD_SUBTYPE_OBJECT &&
                // ADR-0039: resolving — @objectRef may be inherited via extends (TS reads f.attr).
                f.Attr(FIELD_ATTR_OBJECT_REF) is string refName)
            {
                var target = ResolveNestedObjectRef(root, refName);
                if (target is not null && target.SubType == OBJECT_SUBTYPE_VALUE)
                {
                    var children = DerivePayloadFieldTree(root, target, new HashSet<string>(seen, StringComparer.Ordinal));
                    fields.Add(new PayloadField(f.Name, children));
                    continue;
                }
            }
            fields.Add(new PayloadField(f.Name));
        }
        return fields;
    }

    /// <summary>
    /// Resolve a <c>field.object</c>'s <c>@objectRef</c> to its target
    /// <c>object.value</c> by BARE short-name — mirroring the TS render-helper's
    /// <c>findObject(root, ref)</c> (<c>c.type === OBJECT &amp;&amp; c.name === ref</c>)
    /// and the Java <c>resolveNestedObjectRef</c>. If the ref carries a package, only
    /// the segment after the last <c>::</c> is compared, against each
    /// <c>object.value</c>'s own short name. Returns null when no match is found.
    /// </summary>
    private static MetaData? ResolveNestedObjectRef(MetaRoot root, string reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        var refShort = CSharpNaming.StripPkg(reference);
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        return root.Children().FirstOrDefault(c =>
            c.Type == TYPE_OBJECT && c.SubType == OBJECT_SUBTYPE_VALUE &&
            CSharpNaming.StripPkg(c.Name) == refShort);
    }

    /// <summary>
    /// Emit a <c>IReadOnlyList&lt;PayloadField&gt;</c> as a deterministic C# array
    /// literal: <c>new PayloadField[] { new PayloadField("name"),
    /// new PayloadField("nested", new PayloadField[] { ... }) }</c>. An empty tree
    /// emits <c>new global::MetaObjects.Render.PayloadField[] { }</c>.
    /// </summary>
    private static string FieldTreeLiteral(IReadOnlyList<PayloadField> fields)
    {
        var sb = new StringBuilder("new global::MetaObjects.Render.PayloadField[] { ");
        for (int i = 0; i < fields.Count; i++)
        {
            if (i > 0) sb.Append(", ");
            var f = fields[i];
            if (f.Fields is not null)
                sb.Append($"new global::MetaObjects.Render.PayloadField({Quote(f.Name)}, {FieldTreeLiteral(f.Fields)})");
            else
                sb.Append($"new global::MetaObjects.Render.PayloadField({Quote(f.Name)})");
        }
        sb.Append(" }");
        return sb.ToString();
    }

    // -------------------------------------------------------------------------
    // Local helpers
    // -------------------------------------------------------------------------

    /// <summary>Resolve @maxChars as an int, or null when absent/blank/non-numeric.
    /// ADR-0039: resolving — @maxChars may be inherited via an abstract template base.</summary>
    private static int? MaxCharsOf(MetaData tmpl)
    {
        var v = tmpl.Attr(TEMPLATE_ATTR_MAX_CHARS);
        return v switch
        {
            int i => i,
            long l => (int)l,
            string s when int.TryParse(s, out var n) => n,
            _ => null,
        };
    }

    private static string Quote(string s) =>
        "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
