// The orphan sweep: delete a file gen wrote earlier and no longer generates.
//
// The rule every port shares (docs/features/own-your-codegen.md, "Files that are no longer
// generated"; codegen-ts runner.ts / orphan-sweep.ts, Python codegen/orphan_sweep.py):
//
// - A candidate is a file under an output directory of a FULL run that the hash manifest
//   records writing and that no generator of the run emitted. A file the manifest does not
//   record is not ours, whatever its name, and is never touched.
// - An untouched candidate (its content still hashes to what was recorded) is deleted and its
//   manifest entry dropped.
// - An edited candidate is REFUSED by name and stays recorded, so the refusal repeats until
//   someone deletes the file or moves the edits.
// - A recorded path whose file is already gone is forgotten.
//
// `verify --codegen` convicts an extra file on the same evidence (Classify below), so gen
// removes exactly the untouched files the gate reports, which is what makes the gate's
// "regenerate" remedy work. The caller decides whether a run may sweep at all: a run narrowed
// by --generators produces a subset of the output by construction, so every file of the
// unselected part would look orphaned.

namespace MetaObjects.Codegen;

/// <summary>Finds and removes generated files no generator emits any more.</summary>
public static class OrphanSweep
{
    /// <summary>How a committed file that no generator emitted relates to the manifest.</summary>
    public enum Verdict
    {
        /// <summary>The manifest does not record it: never ours, never touched.</summary>
        Stranger,
        /// <summary>Recorded and byte-for-byte what was recorded: safe to delete.</summary>
        Pristine,
        /// <summary>Recorded but edited since: refused by name.</summary>
        Edited,
    }

    /// <summary>The outcome of one sweep.</summary>
    /// <param name="Removed">Files deleted, as the run reports paths (shown label + dir-relative path).</param>
    /// <param name="Refused">Project-relative paths of edited orphans, left in place.</param>
    /// <param name="Discarded">Edited orphans deleted anyway, because every generator writing into
    /// their directory declares <see cref="HandEdits.Overwrite"/> (also in <paramref name="Removed"/>).</param>
    public sealed record Result(IReadOnlyList<string> Removed, IReadOnlyList<string> Refused, IReadOnlyList<string> Discarded);

    /// <summary>
    /// Classify one committed file no generator emitted. <paramref name="full"/> is its absolute
    /// path, <paramref name="dirRel"/> its path relative to the output directory it lives in (the
    /// legacy manifest spelling). A file outside <paramref name="projectRoot"/> is never recorded,
    /// so it is always a stranger.
    /// </summary>
    public static Verdict Classify(
        IReadOnlyDictionary<string, string> hashes, string projectRoot, string full, string dirRel)
    {
        var key = KeyFor(projectRoot, full);
        if (key is null) return Verdict.Stranger;
        string? recorded = hashes.TryGetValue(key, out var h) ? h
            : hashes.TryGetValue(dirRel, out var legacy) ? legacy
            : null;
        if (recorded is null) return Verdict.Stranger;
        string current;
        try { current = File.ReadAllText(full); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return Verdict.Edited; }
        return recorded == HashManifest.ContentHash(current) ? Verdict.Pristine : Verdict.Edited;
    }

    /// <summary>The project-relative manifest key of <paramref name="full"/>, or <c>null</c> when it
    /// lies outside the project. Both sides via <c>Path.GetFullPath</c>, as <see cref="CodegenRunner"/>
    /// keys a write.</summary>
    internal static string? KeyFor(string projectRoot, string full)
    {
        var key = Path.GetRelativePath(Path.GetFullPath(projectRoot), Path.GetFullPath(full));
        return key.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(key) ? null : key;
    }

    private static bool IsUnder(string path, string dir) =>
        Path.GetFullPath(path).StartsWith(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar,
            StringComparison.Ordinal);

    /// <summary>
    /// Delete the untouched files under <paramref name="dirs"/> that the manifest records and
    /// <paramref name="emitted"/> (absolute paths this run produced, refused ones included) does
    /// not hold, and forget every recorded path under those directories whose file is gone.
    /// Each directory comes with the label the run reports its files under. In a directory of
    /// <paramref name="overwriteDirs"/> (absolute paths) an edited orphan is deleted too.
    /// </summary>
    public static Result Sweep(
        string genStateDir, string projectRoot,
        IReadOnlyList<(string Dir, string Label)> dirs, IReadOnlySet<string> emitted,
        IReadOnlySet<string>? overwriteDirs = null)
    {
        var removed = new List<string>();
        var refused = new List<string>();
        var discarded = new List<string>();
        if (!HashManifest.Exists(genStateDir)) return new Result(removed, refused, discarded);
        var hashes = HashManifest.Load(genStateDir);
        var forget = new HashSet<string>(StringComparer.Ordinal);
        var root = Path.GetFullPath(projectRoot);

        var distinct = dirs.DistinctBy(d => Path.GetFullPath(d.Dir)).ToList();
        var all = distinct.Select(d => Path.GetFullPath(d.Dir)).ToList();
        foreach (var (dir, label) in distinct)
        {
            var full = Path.GetFullPath(dir);
            var nested = all.Where(o => o != full && IsUnder(o, full)).ToList();
            var prefix = KeyFor(root, full);
            if (prefix is null) continue; // nothing outside the project is ours to delete
            var overwrite = overwriteDirs?.Contains(full) == true;
            if (Directory.Exists(full))
            {
                foreach (var path in Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories)
                             .OrderBy(p => p, StringComparer.Ordinal))
                {
                    if (emitted.Contains(Path.GetFullPath(path))) continue;
                    if (nested.Any(n => IsUnder(path, n))) continue;
                    var dirRel = Path.GetRelativePath(full, path);
                    if (dirRel.Split(Path.DirectorySeparatorChar).Contains(".metaobjects")) continue;
                    var key = KeyFor(root, path)!;
                    switch (Classify(hashes, root, path, dirRel))
                    {
                        case Verdict.Pristine:
                            File.Delete(path);
                            // Only the spelling it was recorded under: a legacy dir-relative key
                            // is otherwise someone else's record in another directory.
                            forget.Add(hashes.ContainsKey(key) ? key : dirRel);
                            removed.Add(label + dirRel.Replace(Path.DirectorySeparatorChar, '/'));
                            break;
                        case Verdict.Edited when overwrite:
                            File.Delete(path);
                            forget.Add(hashes.ContainsKey(key) ? key : dirRel);
                            removed.Add(label + dirRel.Replace(Path.DirectorySeparatorChar, '/'));
                            discarded.Add(key.Replace(Path.DirectorySeparatorChar, '/'));
                            break;
                        case Verdict.Edited:
                            refused.Add(key.Replace(Path.DirectorySeparatorChar, '/'));
                            break;
                    }
                }
            }
            // Recorded under this directory, not emitted, and already gone: forget it, so a
            // stranger's file created later under that name is not mistaken for ours.
            var under = prefix == "." ? "" : prefix + Path.DirectorySeparatorChar;
            foreach (var key in hashes.Keys)
            {
                if (!key.StartsWith(under, StringComparison.Ordinal)) continue;
                var path = Path.GetFullPath(Path.Combine(root, key));
                if (emitted.Contains(path) || File.Exists(path)) continue;
                if (nested.Any(n => IsUnder(path, n))) continue;
                forget.Add(key);
            }
        }

        if (forget.Count > 0)
        {
            foreach (var key in forget) hashes.Remove(key);
            HashManifest.Save(genStateDir, hashes);
        }
        return new Result(removed, refused.Distinct().Order(StringComparer.Ordinal).ToList(),
            discarded.Distinct().Order(StringComparer.Ordinal).ToList());
    }

    /// <summary>How many leading lines <see cref="SweepMarked"/> reads for the generated marker.</summary>
    private const int MarkerLines = 5;

    /// <summary>
    /// G5 (rc.20): the sweep for a self-hosted runner that keeps no hash manifest (no
    /// <see cref="GenConfig.GenStateDir"/>), so a layout change (the package layout, R39) does not
    /// leave the old files behind. Deletes each file under <paramref name="dirs"/> that carries the
    /// generated marker (<see cref="CodegenRunner.GeneratedMarker"/>) in its first lines and that
    /// <paramref name="emitted"/> (absolute paths; <see cref="CodegenRunner.RunResult.EmittedPaths"/>)
    /// does not hold, and returns the deleted absolute paths, sorted.
    /// <para>
    /// This is the manifest-less write rule turned on deletion: with no manifest, a file carrying the
    /// marker is the generator's to overwrite, edited or not, so it is also the generator's to
    /// delete once nothing emits it. A file without the marker is never touched, nor is anything
    /// under a <c>.metaobjects</c> directory. Opt-in, and only for the caller's own runner: it is
    /// never called by <see cref="CodegenRunner.Run(GenConfig, MetaObjects.Meta.MetaRoot, IReadOnlyList{IGenerator})"/>.
    /// Pass the union of every run's directories and emitted paths when one runner makes several
    /// runs, since a file another run emitted would look orphaned to this one; and call it only
    /// after a run of the whole generator list, for the same reason <see cref="GenConfig.SweepOrphans"/> is.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> SweepMarked(IEnumerable<string> dirs, IReadOnlySet<string> emitted)
    {
        var wanted = new HashSet<string>(emitted.Select(Path.GetFullPath), StringComparer.Ordinal);
        var removed = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var dir in dirs.Select(Path.GetFullPath).Distinct(StringComparer.Ordinal))
        {
            if (!Directory.Exists(dir)) continue;
            foreach (var path in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                var full = Path.GetFullPath(path);
                if (wanted.Contains(full) || removed.Contains(full)) continue;
                if (Path.GetRelativePath(dir, full).Split(Path.DirectorySeparatorChar).Contains(".metaobjects")) continue;
                if (!CarriesMarker(full)) continue;
                File.Delete(full);
                removed.Add(full);
            }
        }
        return removed.ToList();
    }

    private static bool CarriesMarker(string path)
    {
        try
        {
            using var reader = new StreamReader(path);
            for (var i = 0; i < MarkerLines && reader.ReadLine() is { } line; i++)
                if (line.Contains(CodegenRunner.GeneratedMarker, StringComparison.Ordinal)) return true;
            return false;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>The warning for edited orphans. The same wording as codegen-ts's
    /// <c>refusedOrphanMessage</c> and Python's <c>refused_orphan_message</c>: what happened, why
    /// nothing was deleted, and the two ways out.</summary>
    public static string RefusedMessage(IReadOnlyList<string> paths, string owner = "dotnet meta gen") =>
        $"{owner}: {paths.Count} generated file(s) are no longer generated but have been edited by hand, " +
        $"so they were NOT deleted: {string.Join(", ", paths)}. Delete each one, or, if what produced it " +
        "was renamed, move your edits into the newly generated file first and then delete it " +
        "(regeneration cannot follow a rename).";
}
