// `dotnet meta docs` — emit the generated C# SDK api surface (the `api/csharp`
// surface of the cross-port SDK-docs contract) under the --out directory.
//
// Wiring only: the pages come from the `api-docs` generator, which builds them from the
// CSharpApiModelBuilder (the CSharpNaming seam + each generator's AppliesTo predicate) and
// DocsPaths — nothing is re-derived here. CodegenCli.RunDocs collision-checks the output
// paths (duplicate page path → failure) before anything is written, mirroring the Java Mojo.

using MetaObjects.Codegen;
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
    public const string DefaultApiSubDir = DocsRunFacts.DefaultApiSubDir;

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
        // The pipeline is the one an owned codegen/Program.cs runs too (CodegenCli.RunDocs), with the
        // packaged api-docs generator: no owned generator list on this path.
        var outcome = CodegenCli.RunDocs(load, outDir, ns, new DocsRunFacts(project, modelBaseUrl, apiSubDir), []);
        return new Outcome(outcome.LoadErrors, outcome.WrittenPaths, outcome.CollisionError);
    }
}
