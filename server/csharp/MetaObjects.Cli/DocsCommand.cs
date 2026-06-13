// `dotnet meta docs` — emit the generated C# SDK api surface (the `api/csharp`
// surface of the cross-port SDK-docs contract) under the --out directory.
//
// Wiring only: every symbol name comes from the CSharpApiModelBuilder (which keys off
// the CSharpNaming seam + each generator's AppliesTo predicate) and every path comes
// from DocsPaths — nothing is re-derived here. Output paths are collision-checked
// (duplicate page path → failure) before anything is written, mirroring the Java Mojo.

using MetaObjects.Codegen;
using MetaObjects.Codegen.ApiDocs;
using MetaObjects.Loader;

namespace MetaObjects.Cli;

/// <summary>The docs command's pure logic (no console I/O), so it is testable.</summary>
public static class DocsCommand
{
    /// <summary>Result of a docs run: load errors (if any) + the relative page paths written.</summary>
    public sealed record Outcome(IReadOnlyList<string> LoadErrors, IReadOnlyList<string> WrittenPaths)
    {
        public bool Ok => LoadErrors.Count == 0;
    }

    /// <summary>The default api-surface subdir (the cross-port contract's <c>api/csharp</c>).</summary>
    public const string DefaultApiSubDir = "api/csharp";

    /// <summary>
    /// Build the C# api-docs surface for <paramref name="metadataDir"/> and write it under
    /// <paramref name="outDir"/>/<paramref name="apiSubDir"/>. Layout=package (the cross-port
    /// contract). <paramref name="modelBaseUrl"/> federates the model back-links when set.
    /// </summary>
    public static Outcome Run(
        string metadataDir, string outDir, string project,
        string apiSubDir = DefaultApiSubDir, string? modelBaseUrl = null)
    {
        var load = MetaDataLoader.FromDirectory(metadataDir);
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, []);

        // The display namespace seam needs a GenConfig; only Namespace/binding are read.
        var config = new GenConfig { OutDir = outDir, Namespace = "Generated" };
        var model = new CSharpApiModelBuilder(config).Build(load.Root, project);
        var renderer = new CSharpApiDocsRenderer();
        const DocsPaths.Layout layout = DocsPaths.Layout.Package;

        // Collect path → content first so a duplicate page path fails BEFORE any write.
        var emitted = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var unit in model.Units)
        {
            var pagePath = DocsPaths.DocPageOutputPath(layout, unit.Package, unit.Node);
            var apiPagePathFromDocsRoot = apiSubDir + "/" + pagePath;
            var modelHref = DocsPaths.ModelCrossHref(apiPagePathFromDocsRoot, pagePath, modelBaseUrl);
            Put(emitted, pagePath, renderer.RenderUnitPage(unit, modelHref));
        }
        Put(emitted, "README.md", renderer.RenderIndex(model, layout));
        Put(emitted, "AGENT-API.md", renderer.RenderAgentApi(model));

        var apiRoot = Path.Combine(outDir, apiSubDir.Replace('/', Path.DirectorySeparatorChar));
        var written = new List<string>();
        foreach (var (rel, content) in emitted)
        {
            var dest = Path.Combine(apiRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.WriteAllText(dest, content);
            written.Add(apiSubDir + "/" + rel);
        }
        return new Outcome(loadErrors, written);
    }

    private static void Put(Dictionary<string, string> emitted, string path, string content)
    {
        if (!emitted.TryAdd(path, content))
            throw new InvalidOperationException($"dotnet meta docs — duplicate api page output path: {path}");
    }
}
