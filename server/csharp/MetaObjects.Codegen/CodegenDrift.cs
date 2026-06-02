// `dotnet meta verify --codegen` — the codegen-drift gate (ADR-0021 D2).
//
// C# port of the TS reference (cli/src/lib/codegen-drift.ts). Regenerates the
// configured generator suite into a throwaway TEMP directory and DIFFs the
// freshly-generated file tree against the committed output (the GenConfig's
// OutDir). Any difference — a file present in one tree but not the other, or
// differing content — is drift: either "metadata changed but `gen` wasn't
// re-run" or "a generated file was hand-edited". Reuses the exact same
// CodegenRunner pipeline `gen` uses, so the comparison is faithful.
//
// SAFETY: the regen is written ONLY under a fresh temp dir; the real OutDir is
// read but never written. On any outcome the temp tree is removed.

using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>Regenerate-to-temp + diff vs committed output (ADR-0021 D2).</summary>
public static class CodegenDrift
{
    /// <summary>The outcome of a codegen-drift computation (pure; no console I/O).</summary>
    public sealed record Result
    {
        /// <summary>True when the committed output matches a fresh regen exactly.</summary>
        public bool Clean { get; init; }
        /// <summary>Out-dir-relative paths that differ (changed / missing / extra), sorted.</summary>
        public IReadOnlyList<string> DriftedFiles { get; init; } = [];
        /// <summary>Human-readable, one-line-per-file drift summary.</summary>
        public IReadOnlyList<string> Lines { get; init; } = [];
        /// <summary>Set when the gate could not run (e.g. no committed output to diff against).</summary>
        public string? Error { get; init; }
    }

    /// <summary>
    /// Run codegen into a temp tree and diff it against the committed output dir.
    /// </summary>
    /// <param name="config">the gen config (provides OutDir = the committed output).</param>
    /// <param name="root">the loaded model (same object `gen` would use).</param>
    /// <param name="generators">the generator suite (default suite, or a --generators selection).</param>
    public static Result Compute(GenConfig config, MetaRoot root, IReadOnlyList<IGenerator> generators)
    {
        var committed = Path.GetFullPath(config.OutDir);

        // Nothing to diff against → a usage/configuration problem (exit 2 at the
        // CLI), not a drift result. Mirrors the TS "no outDir configured" branch.
        if (!Directory.Exists(committed))
        {
            return new Result
            {
                Clean = false,
                Error =
                    $"verify --codegen: no committed generated output at \"{config.OutDir}\" — " +
                    "cannot locate the output to diff against. Run 'dotnet meta gen' first " +
                    "(or run without --codegen).",
            };
        }

        var tempRoot = Path.Combine(Path.GetTempPath(), "meta-verify-codegen-" + Guid.NewGuid().ToString("N"));
        try
        {
            // Regenerate the SAME suite into the temp tree. A fresh temp dir means
            // every file is written (no @generated-marker skip), so the temp tree is
            // the canonical "what gen would produce right now".
            var tempConfig = config with { OutDir = tempRoot };
            CodegenRunner.Run(tempConfig, root, generators);

            var committedFiles = ListFiles(committed);
            var freshFiles = ListFiles(tempRoot);

            var drifted = new SortedSet<string>(StringComparer.Ordinal);
            var lines = new List<string>();

            foreach (var rel in committedFiles.Union(freshFiles).OrderBy(s => s, StringComparer.Ordinal))
            {
                var inCommitted = committedFiles.Contains(rel);
                var inFresh = freshFiles.Contains(rel);
                if (inCommitted && !inFresh)
                {
                    drifted.Add(rel);
                    lines.Add($"- {rel} (committed but a fresh regen would not emit it)");
                }
                else if (!inCommitted && inFresh)
                {
                    drifted.Add(rel);
                    lines.Add($"+ {rel} (a fresh regen would emit it; not committed — run 'dotnet meta gen')");
                }
                else
                {
                    var a = File.ReadAllText(Path.Combine(committed, rel));
                    var b = File.ReadAllText(Path.Combine(tempRoot, rel));
                    if (!string.Equals(a, b, StringComparison.Ordinal))
                    {
                        drifted.Add(rel);
                        lines.Add($"~ {rel} (committed content differs from a fresh regen)");
                    }
                }
            }

            return new Result
            {
                Clean = drifted.Count == 0,
                DriftedFiles = drifted.ToList(),
                Lines = lines,
            };
        }
        finally
        {
            try { if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true); }
            catch { /* best effort */ }
        }
    }

    /// <summary>List files under <paramref name="dir"/> as dir-relative, forward-slash paths.</summary>
    private static HashSet<string> ListFiles(string dir)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        if (!Directory.Exists(dir)) return set;
        foreach (var full in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            set.Add(Path.GetRelativePath(dir, full).Replace(Path.DirectorySeparatorChar, '/'));
        return set;
    }
}
