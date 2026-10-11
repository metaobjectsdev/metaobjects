// api-docs — the C# SDK api reference (the `api/csharp` surface of the cross-port SDK-docs
// contract): one page per entity, value object, projection, served report and template, an
// index, and the agent-facing AGENT-API page.
//
// Run by `dotnet meta docs`, not by `dotnet meta gen` (it implements IDocsGenerator): its files
// land under the docs output directory, relative to it. The project label, the model back-link
// base and the api subdirectory come from the docs run (`ctx.Docs`), and what each documented
// generator emits for comes from `ctx.Applicability`, so an owned copy of this generator
// documents the generators the project actually runs. The page IR, the renderer and the page
// paths live beside it (ApiDocs/), and eject hands them over with it.

using MetaObjects.Codegen.ApiDocs;

namespace MetaObjects.Codegen.Generators;

public sealed class ApiDocsGenerator : IDocsGenerator
{
    public string Name => "api-docs";

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // A docs run supplies the facts. A caller that runs this generator directly, as a registry-wide
        // probe does, gets the packaged defaults and a neutral project label.
        var facts = ctx.Docs ?? new DocsRunFacts("project");

        var model = new CSharpApiModelBuilder(ctx.Config, ctx.Applicability).Build(ctx.Root, facts.Project);
        var renderer = new CSharpApiDocsRenderer();
        const DocsPaths.Layout layout = DocsPaths.Layout.Package;

        foreach (var unit in model.Units)
        {
            var pagePath = DocsPaths.DocPageOutputPath(layout, unit.Package, unit.Node);
            var modelHref = DocsPaths.ModelCrossHref(facts.ApiSubDir + "/" + pagePath, pagePath, facts.ModelBaseUrl);
            yield return Page(facts, pagePath, renderer.RenderUnitPage(unit, modelHref));
        }
        yield return Page(facts, "README.md", renderer.RenderIndex(model, layout));
        yield return Page(facts, "AGENT-API.md", renderer.RenderAgentApi(model));
    }

    private static EmittedFile Page(DocsRunFacts facts, string pagePath, string content) =>
        new(facts.ApiSubDir + "/" + pagePath, content);
}
