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

using System.Text.RegularExpressions;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>Regenerate-to-temp + diff vs committed output (ADR-0021 D2).</summary>
public static class CodegenDrift
{
    // Matches the FIRST top-level namespace declaration in a C# source file:
    // file-scoped `namespace X.Y;` or block `namespace X.Y {` / `namespace X.Y`.
    // Multiline so `^` anchors each line; we scan line-leading declarations only.
    private static readonly Regex NamespaceDecl =
        new(@"^\s*namespace\s+([A-Za-z_][\w.]*)\s*;?", RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>
    /// Infer the C# namespace embedded in the committed generated output under
    /// <paramref name="outDir"/>. Scans the FIRST <c>.cs</c> file (ordinal-sorted)
    /// that carries a top-level <c>namespace</c> declaration and returns it.
    /// Returns <c>null</c> when the dir is missing or no <c>.cs</c> file declares a
    /// namespace — the caller then falls back to its default (there is nothing
    /// meaningful to diff against in that case anyway). Used by
    /// <c>verify --codegen</c> so a regen matches output produced with ANY namespace
    /// when <c>--namespace</c> is omitted.
    /// </summary>
    public static string? InferNamespace(string outDir)
    {
        if (!Directory.Exists(outDir)) return null;

        var csFiles = Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories)
            .OrderBy(p => p.Replace(Path.DirectorySeparatorChar, '/'), StringComparer.Ordinal);

        foreach (var file in csFiles)
        {
            string text;
            try { text = File.ReadAllText(file); }
            catch { continue; }

            var m = NamespaceDecl.Match(text);
            if (m.Success) return m.Groups[1].Value;
        }
        return null;
    }

    /// <summary>The outcome of a codegen-drift computation (pure; no console I/O).</summary>
    public sealed record Result
    {
        /// <summary>True when the committed output matches a fresh regen exactly.</summary>
        public bool Clean { get; init; }
        /// <summary>Out-dir-relative paths that differ (changed / missing / extra), sorted.</summary>
        public IReadOnlyList<string> DriftedFiles { get; init; } = [];
        /// <summary>Human-readable, one-line-per-file drift summary.</summary>
        public IReadOnlyList<string> Lines { get; init; } = [];
        /// <summary>Set when the gate could not run (e.g. the regen failed).</summary>
        public string? Error { get; init; }
    }

    /// <summary>
    /// Run codegen into a temp tree and diff it against the committed output dir.
    /// </summary>
    /// <param name="config">the gen config (provides OutDir = the committed output).</param>
    /// <param name="root">the loaded model (same object `gen` would use).</param>
    /// <param name="generators">the generator suite — always a --generators selection;
    /// this port has no default set (see GenCommand.NoGeneratorsSelected).</param>
    /// <param name="narrowed">the suite is a <c>--generators</c> narrowing of the declared list. Only
    /// the directories a selected entry writes to are compared, and a committed file the regen does
    /// not emit is not drift: it may belong to an entry the narrowing left out.</param>
    public static Result Compute(GenConfig config, MetaRoot root, IReadOnlyList<IGenerator> generators, bool narrowed = false)
    {
        // Every directory the list writes into: the run's --out, then each entry's own
        // OutDir (ADR-0034 Amendment 9 — the api reference has one), each compared whole.
        // `label` is how a drifted file is reported: --out-relative for the run's own
        // directory, prefixed with the entry's OutDir as written for the others.
        var realRootFor = CodegenRunner.OutRootFor(config);
        var roots = new List<(string Committed, string Label)>();
        if (!narrowed || generators.Any(g => g.OutDir is not { Length: > 0 }))
            roots.Add((Path.GetFullPath(config.OutDir), ""));
        foreach (var g in generators)
        {
            var dir = Path.GetFullPath(realRootFor(g));
            if (roots.All(r => r.Committed != dir))
                roots.Add((dir, g.OutDir!.TrimEnd('/', '\\') + "/"));
        }

        // A directory is created only when gen writes a file into it, and git keeps no empty
        // one, so a missing directory, --out included, is an empty committed tree.
        var tempRoot = Path.Combine(Path.GetTempPath(), "meta-verify-codegen-" + Guid.NewGuid().ToString("N"));
        try
        {
            // Regenerate the SAME suite into the temp tree, each directory into a temp
            // directory of its own. A fresh temp dir means every file is written (no
            // @generated-marker skip), so the temp tree is the canonical "what gen would
            // produce right now".
            var temps = roots.Select((_, i) => Path.Combine(tempRoot, i.ToString())).ToList();
            var tempConfig = config with { OutDir = temps[0] };
            CodegenRunner.Run(tempConfig, root, generators,
                g => temps[roots.FindIndex(r => r.Committed == Path.GetFullPath(realRootFor(g)))]);

            var drifted = new SortedSet<string>(StringComparer.Ordinal);
            var lines = new List<string>();
            for (var i = 0; i < roots.Count; i++)
            {
                // A directory nested in this one is another entry's, and is compared as its own.
                var nested = roots.Where((r, j) => j != i && IsUnder(r.Committed, roots[i].Committed))
                    .Select(r => r.Committed).ToList();
                Diff(roots[i].Committed, nested, temps[i], roots[i].Label, !narrowed, drifted, lines);
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

    /// <summary>Compare one committed directory, less the <paramref name="nested"/> directories, with its
    /// fresh regen, adding each difference. A committed file the regen does not emit is reported only when
    /// <paramref name="reportExtra"/>.</summary>
    private static void Diff(
        string committed, IReadOnlyList<string> nested, string fresh, string label, bool reportExtra,
        SortedSet<string> drifted, List<string> lines)
    {
        var committedFiles = ListFiles(committed);
        committedFiles.RemoveWhere(rel => nested.Any(n => IsUnder(Path.Combine(committed, rel), n)));
        var freshFiles = ListFiles(fresh);
        foreach (var rel in committedFiles.Union(freshFiles).OrderBy(s => s, StringComparer.Ordinal))
        {
            var shown = label + rel;
            var inCommitted = committedFiles.Contains(rel);
            var inFresh = freshFiles.Contains(rel);
            if (inCommitted && !inFresh)
            {
                if (!reportExtra) continue;
                drifted.Add(shown);
                lines.Add($"- {shown} (committed but a fresh regen would not emit it)");
            }
            else if (!inCommitted && inFresh)
            {
                drifted.Add(shown);
                lines.Add($"+ {shown} (a fresh regen would emit it; not committed — run 'dotnet meta gen')");
            }
            else
            {
                var a = File.ReadAllText(Path.Combine(committed, rel));
                var b = File.ReadAllText(Path.Combine(fresh, rel));
                if (!string.Equals(a, b, StringComparison.Ordinal))
                {
                    drifted.Add(shown);
                    lines.Add($"~ {shown} (committed content differs from a fresh regen)");
                }
            }
        }
    }

    /// <summary>True when <paramref name="path"/> lies inside the directory <paramref name="dir"/>.</summary>
    private static bool IsUnder(string path, string dir) =>
        Path.GetFullPath(path).StartsWith(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar,
            StringComparison.Ordinal);

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
