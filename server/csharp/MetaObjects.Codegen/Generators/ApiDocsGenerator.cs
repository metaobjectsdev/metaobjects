// api-docs — the C# SDK api reference (the `api/csharp` surface of the cross-port SDK-docs
// contract): one page per entity, value object, projection, served report and template, an
// index, and the agent-facing AGENT-API page.
//
// An ordinary entry in codegen/Generators.cs, run by `dotnet meta gen` like every other
// (ADR-0034 Amendment 9). Its options are init properties: the output directory, the api
// subdirectory under it, the project label and the model back-link base. What each documented
// generator emits for comes from `ctx.Applicability`, so an owned copy of this generator names no
// emitting generator. The page IR, the renderer and the page paths live beside it (ApiDocs/),
// and eject hands them over with it.

using MetaObjects.Codegen.ApiDocs;

namespace MetaObjects.Codegen.Generators;

public sealed class ApiDocsGenerator : IGenerator
{
    /// <summary>The api-surface subdirectory of the cross-port docs contract.</summary>
    public const string DefaultApiSubDir = "api/csharp";

    public string Name => "api-docs";

    /// <summary>The docs output root the pages are written under. Give it a directory that holds
    /// generated files only: <c>verify --codegen</c> compares the whole tree. <c>null</c> writes
    /// under the run's <c>--out</c>.</summary>
    public string? OutDir { get; init; }

    /// <summary>Where under <see cref="OutDir"/> the api reference lands.</summary>
    public string ApiSubDir { get; init; } = DefaultApiSubDir;

    /// <summary>The label the agent page carries in its header.</summary>
    public string ProjectName { get; init; } = "project";

    /// <summary>When set, the base URL the model pages' back-links federate to.</summary>
    public string? ModelBaseUrl { get; init; }

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var model = new CSharpApiModelBuilder(ctx.Config, ctx.Applicability).Build(ctx.Root, ProjectName);
        var renderer = new CSharpApiDocsRenderer();
        const DocsPaths.Layout layout = DocsPaths.Layout.Package;

        foreach (var unit in model.Units)
        {
            var pagePath = DocsPaths.DocPageOutputPath(layout, unit.Package, unit.Node);
            var modelHref = DocsPaths.ModelCrossHref(ApiSubDir + "/" + pagePath, pagePath, ModelBaseUrl);
            yield return Page(pagePath, renderer.RenderUnitPage(unit, modelHref));
        }
        yield return Page("README.md", renderer.RenderIndex(model, layout));
        yield return Page("AGENT-API.md", renderer.RenderAgentApi(model));
    }

    private EmittedFile Page(string pagePath, string content) => new(ApiSubDir + "/" + pagePath, content);
}
