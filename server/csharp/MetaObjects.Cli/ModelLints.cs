// `dotnet meta verify` — runs the three MODEL authoring lints (overlay, node names, deprecated
// references) and prints them in the Node `meta verify` order: overlays, names, deprecations. Each
// is advisory and muted by its own flag or environment variable; none reaches the exit code.

using MetaObjects.Config;
using MetaObjects.Loader;

namespace MetaObjects.Cli;

/// <summary>The three model authoring lints <c>dotnet meta verify</c> runs on every invocation.</summary>
public static class ModelLints
{
    /// <summary>Which of the three lints run; each is on unless its flag or environment variable mutes it.</summary>
    public sealed record Selection(bool Overlays, bool Names, bool Deprecations)
    {
        /// <summary>The selection the flags leave, with each lint's <c>META_NO_*_LINT=1</c> applied.</summary>
        public static Selection From(bool noOverlay, bool noNames, bool noDeprecations) => new(
            !noOverlay && !OptedOut(OverlayLint.EnvOptOut),
            !noNames && !OptedOut(NameLint.EnvOptOut),
            !noDeprecations && !OptedOut(DeprecationLint.EnvOptOut));

        private static bool OptedOut(string env) => Environment.GetEnvironmentVariable(env) == "1";
    }

    /// <summary>
    /// Every metadata source in LOAD ORDER, dependency snapshots first under their <c>dep:</c> ids, then
    /// the project's own files named relative to <paramref name="baseDir"/> with forward slashes.
    /// </summary>
    public static List<IMetaDataSource> Sources(ResolvedMetadata meta, string baseDir)
    {
        var sources = new List<IMetaDataSource>(meta.Imports?.Sources() ?? []);
        var files = meta.Files ?? new DirectorySource(meta.Directory).Expand().Select(f => f.FilePath).ToList();
        foreach (var file in files)
            sources.Add(new FileSource(file, Path.GetRelativePath(baseDir, file).Replace('\\', '/')));
        return sources;
    }

    /// <summary>
    /// Run the selected lints and print their findings to <paramref name="stderr"/>. The overlay lint
    /// reads the raw files, so it runs even when the model does not load; the other two read the loaded
    /// model and stay silent when it does not (the load failure is reported by the gates).
    /// </summary>
    public static void RunAdvisory(ResolvedMetadata meta, string baseDir, Selection selection, TextWriter stderr)
    {
        if (!selection.Overlays && !selection.Names && !selection.Deprecations) return;
        List<LintFinding> overlays = [], names = [], deprecations = [];
        try
        {
            if (selection.Overlays) overlays = OverlayLint.Lint(Sources(meta, baseDir));
            if (selection.Names || selection.Deprecations)
            {
                var load = meta.Load();
                if (load.Errors.Count == 0)
                {
                    if (selection.Names) names = NameLint.Lint(load.Root);
                    if (selection.Deprecations) deprecations = DeprecationLint.Lint(load.Root);
                }
            }
        }
        catch (Exception)
        {
            // an advisory lint never breaks verify; print what was gathered
        }
        LintText.Print(stderr, $"overlays: {overlays.Count} unflagged cross-file redeclaration(s)", overlays);
        LintText.Print(stderr, $"names: {names.Count} authoring warning(s)", names);
        LintText.Print(stderr, $"deprecations: {deprecations.Count} reference(s) to a deprecated node", deprecations);
    }
}
