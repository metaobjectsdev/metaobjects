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
        /// <summary>Set when the gate could not run (e.g. the regen failed).</summary>
        public string? Error { get; init; }
        /// <summary>The subset of <see cref="DriftedFiles"/> that no generator emits any more AND that
        /// was edited since gen wrote it, sorted. <c>dotnet meta gen</c> deletes an untouched orphan but
        /// refuses one of these, so "regenerate" would loop: the remedy is to delete the file.</summary>
        public IReadOnlyList<string> EditedOrphans { get; init; } = [];
    }

    /// <summary>
    /// What to do about a drifted <paramref name="result"/>: "regenerate" when regenerating fixes
    /// at least one file, and, for orphans edited by hand, that gen will not delete them. Every
    /// drift report prints these, so the advice cannot loop: gen deletes an untouched orphan and
    /// refuses an edited one.
    /// </summary>
    public static IReadOnlyList<string> Remedy(Result result)
    {
        var lines = new List<string>();
        if (result.DriftedFiles.Count > result.EditedOrphans.Count)
            lines.Add("Run 'dotnet meta gen' to regenerate (it needs --out, the same directory you gave this command), then commit the result.");
        if (result.EditedOrphans.Count > 0)
            lines.Add("For the file(s) above that no generator emits any more and that were edited by hand, " +
                "'dotnet meta gen' will NOT delete them. Delete each one, or move your edits into a file of your own first.");
        return lines;
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
            // No manifest and no sweep for the throwaway regen: it records nothing and deletes
            // nothing, and a fresh temp tree writes every file either way.
            var tempConfig = config with { OutDir = temps[0], GenStateDir = null, ProjectRoot = null, SweepOrphans = false };
            CodegenRunner.RunResult regen;
            try
            {
                regen = CodegenRunner.Run(tempConfig, root, generators,
                    g => temps[roots.FindIndex(r => r.Committed == Path.GetFullPath(realRootFor(g)))]);
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
            {
                return new Result { Clean = false, Error = $"verify --codegen: {ex.Message}" };
            }
            var overwriteDirs = CodegenRunner.OverwriteDirs(generators, realRootFor, config.OutDir);

            var drifted = new SortedSet<string>(StringComparer.Ordinal);
            var lines = new List<string>();
            var editedOrphans = new SortedSet<string>(StringComparer.Ordinal);
            // The manifest gen wrote, when the caller names the project. With write records, an
            // extra file is convicted only when gen recorded writing it, the jurisdiction gen's
            // orphan sweep deletes in; with none, a stale file cannot be told from a stranger's,
            // and every extra file is reported as before.
            var manifest = config.GenStateDir is { } gs && config.ProjectRoot is not null
                ? HashManifest.Load(gs) : null;
            var orphans = manifest is { Count: > 0 } ? new OrphanContext(manifest, config.ProjectRoot!) : null;
            var handEdits = new HandEditsContext(regen.OverwritePaths, overwriteDirs);
            for (var i = 0; i < roots.Count; i++)
            {
                // A directory nested in this one is another entry's, and is compared as its own.
                var nested = roots.Where((r, j) => j != i && IsUnder(r.Committed, roots[i].Committed))
                    .Select(r => r.Committed).ToList();
                Diff(roots[i].Committed, nested, temps[i], roots[i].Label, !narrowed, orphans, handEdits,
                    drifted, lines, editedOrphans);
            }

            return new Result
            {
                Clean = drifted.Count == 0,
                DriftedFiles = drifted.ToList(),
                Lines = lines,
                EditedOrphans = editedOrphans.ToList(),
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
        OrphanContext? orphans, HandEditsContext handEdits,
        SortedSet<string> drifted, List<string> lines, SortedSet<string> editedOrphans)
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
                if (orphans is null)
                {
                    drifted.Add(shown);
                    lines.Add($"- {shown} (committed but a fresh regen would not emit it)");
                    continue;
                }
                // Asked of the same evidence gen's sweep asks (OrphanSweep.Classify), so gen
                // removes exactly what is reported here as removable.
                var full = Path.Combine(committed, rel);
                var dirRel = rel.Replace('/', Path.DirectorySeparatorChar);
                switch (OrphanSweep.Classify(orphans.Hashes, orphans.ProjectRoot, full, dirRel))
                {
                    case OrphanSweep.Verdict.Stranger:
                        continue; // never ours: gen never touches it, so neither does the gate
                    case OrphanSweep.Verdict.Pristine:
                        drifted.Add(shown);
                        lines.Add($"- {shown} (committed but a fresh regen would not emit it; 'dotnet meta gen' deletes it)");
                        break;
                    case OrphanSweep.Verdict.Edited when handEdits.OverwriteDirs.Contains(Path.GetFullPath(committed)):
                        drifted.Add(shown);
                        lines.Add($"- {shown} (no generator emits it any more, and it was edited by hand; " +
                            "handEdits is Overwrite, so 'dotnet meta gen' deletes it)");
                        break;
                    default:
                        drifted.Add(shown);
                        editedOrphans.Add(shown);
                        lines.Add($"- {shown} (no generator emits it any more, and it was edited by hand: " +
                            "delete it, or move your edits into a file of your own and then delete it)");
                        break;
                }
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
                    var full = Path.Combine(committed, rel);
                    var edited = orphans is not null
                        && handEdits.OverwritePaths.Contains(Path.GetFullPath(Path.Combine(fresh, rel)))
                        && OrphanSweep.Classify(orphans.Hashes, orphans.ProjectRoot, full,
                            rel.Replace('/', Path.DirectorySeparatorChar)) == OrphanSweep.Verdict.Edited;
                    lines.Add(edited
                        ? $"~ {shown} (edited by hand; its generator sets handEdits: Overwrite, so 'dotnet meta gen' " +
                          "replaces it with fresh output)"
                        : $"~ {shown} (committed content differs from a fresh regen)");
                }
            }
        }
    }

    /// <summary>The manifest and project an extra file is classified against.</summary>
    private sealed record OrphanContext(IReadOnlyDictionary<string, string> Hashes, string ProjectRoot);

    /// <summary>The regen's <see cref="HandEdits.Overwrite"/> paths (temp tree) and the committed
    /// directories whose edited orphans gen deletes.</summary>
    private sealed record HandEditsContext(IReadOnlySet<string> OverwritePaths, IReadOnlySet<string> OverwriteDirs);

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
