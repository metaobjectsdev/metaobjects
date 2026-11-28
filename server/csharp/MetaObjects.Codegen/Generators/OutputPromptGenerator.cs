// output-prompt-generator — for each responding `template.prompt` (one carrying `@responseRef`),
// emits a `<PromptName>.responseFormat.cs` file declaring a static `<PromptName>ResponseFormat`
// class with a `RenderFormat()` / `RenderFormat(PromptOverrides)` pair backed by the render
// engine's OutputFormatRenderer (FR-010 artifact 1 — the "produce your answer like this"
// fragment).
//
// ADR-0052: gated on `@responseRef` presence, like every other inbound generator. It previously
// keyed on `template.output` + a json/xml `@format` gate, which is how a fragment that instructs
// an LLM came to be emitted from the subtype defined as "every rendered artifact other than an
// LLM prompt".
//
// The baked OutputFormatSpec's rootName is the RESPONSE VO's class name, so the fragment and the
// extract() codegen agree on the root element/object name. Mirrors the Java
// SpringOutputPromptGenerator. Skips: template.output, and a missing/unresolved `@responseRef`.

using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Emits one <c>&lt;Prompt&gt;ResponseFormat</c> class per responding <c>template.prompt</c>,
/// exposing <c>RenderFormat()</c> + <c>RenderFormat(PromptOverrides)</c>.
/// </summary>
public class OutputPromptGenerator : IGenerator
{
    public virtual string Name => "output-prompt-generator";

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var files = new List<EmittedFile>();
        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        foreach (var tmpl in FindInbound.InboundTemplates(ctx.Root))
        {
            // @responseRef must resolve to a value-object (same contract as the parser).
            if (FindInbound.ResponseShape(ctx.Root, tmpl) is not { } shape) continue;
            files.Add(EmitPrompt(tmpl, shape.Vo, shape.Ref, ctx));
        }
        return files;
    }

    /// <summary>
    /// True iff this generator emits a response-format fragment for <paramref name="tmpl"/>: a
    /// <c>template.prompt</c> whose <c>@responseRef</c> resolves to a root-level <c>object</c>.
    /// Single source of truth shared by the generator loop AND the api-docs builder (so docs
    /// never claim a suppressed symbol).
    /// </summary>
    public static bool AppliesTo(MetaData tmpl, MetaRoot root) => FindInbound.IsInbound(tmpl, root);

    protected virtual EmittedFile EmitPrompt(MetaData tmpl, MetaData vo, string payloadRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var promptClass = CSharpNaming.ResponseFormatClassName(templateName);
        ctx.Claim($"the C# namespace {ctx.Config.Namespace}", promptClass, tmpl.ResolutionKey(), "rename one (an output prompt is declared in the configured namespace, GenConfig.Namespace, whatever its package, "
            + "so the two packages do not keep them apart)");
        // rootName == the response value object's short name, so the fragment and extract()
        // agree — never the raw @responseRef, which may be an FQN (`acme::app::Answer`).
        var specLiteral = OutputFormatSpecEmitter.SpecLiteral(vo, tmpl, vo.Name);

        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        w.Line($"namespace {ctx.Config.Namespace};");
        w.Blank();
        w.Line($"/// <summary>Response-format prompt fragment for the <c>{templateName}</c> template.prompt.</summary>");
        using (w.Braced($"public static class {promptClass}"))
        {
            WriteSpec(w, specLiteral);
            w.Blank();
            WriteRenderFormat(w);
        }
        // ADR-0052 D4: the artifact name follows the DIRECTION axis. A file named
        // `<Prompt>.prompt.cs` generated from a prompt reproduces the confusion being removed.
        return new EmittedFile(OutputPaths.Of(tmpl, ctx, $"{templateName}.responseFormat.cs"), w.ToString()) { SourceNode = tmpl.ResolutionKey() };
    }

    // The pieces of the file, one overridable method each (ADR-0063 item 7): a subclass changes the
    // piece it wants and keeps the rest. Not a stability contract.

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>The generated-file marker, the nullable context and the usings.</summary>
    protected virtual void WriteFileHeader(CsWriter w)
    {
        w.GeneratedFileHeader("output-prompt-generator");
        w.Using("System.Collections.Generic");
        w.Using("MetaObjects.Render.Prompt");
        w.Using("MetaObjects.Render.Extract");
    }

    /// <summary>The baked <c>OutputFormatSpec</c> field.</summary>
    protected virtual void WriteSpec(CsWriter w, string specLiteral) =>
        w.Line($"private static readonly OutputFormatSpec Spec = {specLiteral};");

    /// <summary>The two <c>RenderFormat</c> entry points.</summary>
    protected virtual void WriteRenderFormat(CsWriter w)
    {
        w.Line("/// <summary>The response-format instruction fragment (\"produce your answer like this\").</summary>");
        w.Line("public static string RenderFormat() => OutputFormatRenderer.Render(Spec, PromptOverrides.None());");
        w.Blank();
        w.Line("/// <summary>The fragment with render-time overrides (style / per-field example / instruction).</summary>");
        w.Line("public static string RenderFormat(PromptOverrides overrides) => OutputFormatRenderer.Render(Spec, overrides);");
    }
}
