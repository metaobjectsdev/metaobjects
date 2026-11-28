// metamodel-docs — the reference of the built-in metamodel: every type, subtype and attribute
// the build registers, by provider. INDEX.md, providers.md and one types/<family>.md per type
// family, rendered from the shared Mustache templates (templates/metamodel/) over the page data
// MetamodelDocsPages builds from this port's registry and embedded provider definitions.
//
// An ordinary entry in codegen/Generators.cs, run by `dotnet meta gen` (ADR-0034 Amendment 9).
// It reads no model objects. The shipped templates are read from the package; a file named
// `metamodel/<page>.mustache` under TemplateRoot (the project's template directory) wins.

using System.Text.Json;
using MetaObjects.Render;

namespace MetaObjects.Codegen.Generators;

public class MetamodelDocsGenerator : IGenerator
{
    /// <summary>The sub-directory the pages are written under.</summary>
    public const string DefaultSubDir = "metamodel";

    public string Name => "metamodel-docs";

    /// <summary>The docs output root the pages are written under; <c>null</c> writes under the run's <c>--out</c>.</summary>
    public string? OutDir { get; init; }

    /// <summary>Where under <see cref="OutDir"/> the pages land; <c>""</c> writes them at its root.</summary>
    public string SubDir { get; init; } = DefaultSubDir;

    /// <summary>A project template directory: <c>metamodel/index.md.mustache</c> (and the other two) there override the shipped ones.</summary>
    public string? TemplateRoot { get; init; }

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var descriptions = ReadDescriptions();
        var pages = MetamodelDocsPages.BuildBuiltIn(descriptions);
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            [MetamodelDocsPages.IndexPageRef] = Template("index.md"),
            [MetamodelDocsPages.ProvidersPageRef] = Template("providers.md"),
            [MetamodelDocsPages.TypePageRef] = Template("type-page.md"),
        });
        foreach (var page in pages)
        {
            var text = Renderer.Render(new RenderRequest
            {
                Ref = page.Template,
                Payload = page.Data,
                Provider = provider,
                Format = Escapers.FORMAT_TEXT,
            });
            yield return new EmittedFile(string.IsNullOrEmpty(SubDir) ? page.Path : SubDir + "/" + page.Path, text) { WholeModel = true };
        }
    }

    private const string ResourcePrefix = "MetaObjects.Codegen.Templates.metamodel.";

    private static string ReadResource(string file)
    {
        using var stream = typeof(IGenerator).Assembly.GetManifestResourceStream(ResourcePrefix + file)
            ?? throw new InvalidOperationException($"embedded template missing: {ResourcePrefix}{file}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private string Template(string page)
    {
        var file = page + ".mustache";
        if (TemplateRoot is { Length: > 0 } root)
        {
            var path = Path.Combine(root, "metamodel", file);
            if (File.Exists(path)) return File.ReadAllText(path);
        }
        return ReadResource(file);
    }

    private static Dictionary<string, string> ReadDescriptions()
    {
        using var doc = JsonDocument.Parse(ReadResource("provider-descriptions.json"));
        return doc.RootElement.EnumerateObject()
            .Where(p => p.Value.ValueKind == JsonValueKind.String)
            .ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
    }
}
