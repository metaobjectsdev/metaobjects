// A declarative template-spec (SP-1) as one entry in codegen/Generators.cs (ADR-0034
// Amendment 9: one list, one declaration). Through 1.0 the gen command also discovered a
// project-root template-spec.json, or read --template-spec; a spec runs now only where the
// list declares it, with its file and template root as init properties.

using System.Text.Json;
using MetaObjects.Render;

namespace MetaObjects.Codegen.TemplateCodegen;

/// <summary>Runs every generator of a template-spec file, as one entry of the generator list.</summary>
public sealed class TemplateSpecGenerator : IGenerator
{
    public string Name => "template-spec";

    /// <summary>The template-spec JSON file, taken from the directory the run starts in.</summary>
    public required string Spec { get; init; }

    /// <summary>The directory template refs resolve under. <c>null</c> takes the run's <c>--template-root</c>,
    /// else <see cref="CodegenCli.DefaultTemplateRoot"/>: <c>prompts</c> when it exists, else <c>templates</c>.</summary>
    public string? TemplateRoot { get; init; }

    /// <inheritdoc />
    public string? OutDir { get; init; }

    /// <summary>The spec's generators, read from <see cref="Spec"/> each time they are asked for.</summary>
    public IReadOnlyList<IGenerator> Generators()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Spec));
        var provider = new FilesystemProvider(TemplateRoot ?? CodegenCli.DefaultTemplateRoot());
        return TemplateSpec.ToGenerators(TemplateSpec.Parse(doc.RootElement), provider);
    }

    public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        Generators().SelectMany(g => g.Generate(ctx));
}
