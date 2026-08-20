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
    /// <summary>
    /// Result of a docs run: load errors (if any), a duplicate-page-path collision message
    /// (if any), and the relative page paths written.
    /// </summary>
    public sealed record Outcome(
        IReadOnlyList<string> LoadErrors, IReadOnlyList<string> WrittenPaths, string? CollisionError = null)
    {
        public bool Ok => LoadErrors.Count == 0 && CollisionError is null;
    }

    /// <summary>The default api-surface subdir (the cross-port contract's <c>api/csharp</c>).</summary>
    public const string DefaultApiSubDir = "api/csharp";

    /// <summary>
    /// Build the C# api-docs surface for <paramref name="metadataDir"/> and write it under
    /// <paramref name="outDir"/>/<paramref name="apiSubDir"/>. Layout=package (the cross-port
    /// contract). <paramref name="modelBaseUrl"/> federates the model back-links when set.
    /// </summary>
    /// <param name="ns">
    /// The C# namespace the documented symbols live in — MUST match the namespace
    /// <c>dotnet meta gen</c> emits under (the CLI defaults both to the same value) so the
    /// rendered <c>using &lt;ns&gt;;</c> import lines are the ones an adopter actually writes.
    /// </param>
    public static Outcome Run(
        string metadataDir, string outDir, string project, string ns,
        string apiSubDir = DefaultApiSubDir, string? modelBaseUrl = null)
        => Run(MetaDataLoader.FromDirectory(metadataDir), outDir, project, ns, apiSubDir, modelBaseUrl);

    /// <summary>
    /// Same as the <c>metadataDir</c> overload above, but starting from an
    /// ALREADY-LOADED <paramref name="load"/> — see the identical overload on
    /// <see cref="GenCommand"/> for why (the CLI's config-ladder path resolves +
    /// loads once via <c>MetaDataLoader.FromUris</c>, correctly excluding
    /// <c>_pending</c> drafts; a second <c>FromDirectory</c> call here would both
    /// re-walk the tree and silently lose that exclusion).
    /// </summary>
    public static Outcome Run(
        LoadResult load, string outDir, string project, string ns,
        string apiSubDir = DefaultApiSubDir, string? modelBaseUrl = null)
    {
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, []);

        // The display namespace seam needs a GenConfig; only Namespace/binding are read.
        var config = new GenConfig { OutDir = outDir, Namespace = ns };
        var model = new CSharpApiModelBuilder(config).Build(load.Root, project);
        var renderer = new CSharpApiDocsRenderer();
        const DocsPaths.Layout layout = DocsPaths.Layout.Package;

        // Collect path → content first so a duplicate page path fails BEFORE any write.
        // A collision is a clean, reportable diagnostic (not an uncaught throw out of the CLI).
        var emitted = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            foreach (var unit in model.Units)
            {
                var pagePath = DocsPaths.DocPageOutputPath(layout, unit.Package, unit.Node);
                var apiPagePathFromDocsRoot = apiSubDir + "/" + pagePath;
                var modelHref = DocsPaths.ModelCrossHref(apiPagePathFromDocsRoot, pagePath, modelBaseUrl);
                Put(emitted, pagePath, renderer.RenderUnitPage(unit, modelHref));
            }
            Put(emitted, "README.md", renderer.RenderIndex(model, layout));
            Put(emitted, "AGENT-API.md", renderer.RenderAgentApi(model));
        }
        catch (DuplicatePagePathException ex)
        {
            return new Outcome(loadErrors, [], ex.Message);
        }

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
            throw new DuplicatePagePathException($"dotnet meta docs — duplicate api page output path: {path}");
    }

    /// <summary>Raised when two units resolve to the same api doc page path (a collision).</summary>
    private sealed class DuplicatePagePathException(string message) : Exception(message);
}
