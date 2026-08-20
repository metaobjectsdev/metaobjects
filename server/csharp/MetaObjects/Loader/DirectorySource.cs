// DirectorySource — a metadata source-set backed by a directory.
//
// Discovers .json / .yaml / .yml files in a directory (recursive by default),
// applies optional filename-exclude patterns, sorts deterministically by full
// path (ordinal), and expands into a sequence of FileSource instances.
//
// Mirrors the cross-language DirectorySource contract (see
// docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md).

namespace MetaObjects.Loader;

/// <summary>
/// A directory of metadata files. Discovers <c>.json</c> / <c>.yaml</c> / <c>.yml</c>
/// files and expands into a deterministically-ordered sequence of
/// <see cref="FileSource"/> instances.
/// </summary>
public sealed class DirectorySource
{
    /// <summary>Optional configuration for <see cref="DirectorySource"/>.</summary>
    public sealed class Options
    {
        /// <summary>Filename patterns to exclude (literal, or trailing/leading '*').</summary>
        public IReadOnlyList<string>? Exclude { get; init; }

        /// <summary>Recurse into subdirectories. Default: true.</summary>
        public bool Recurse { get; init; } = true;

        /// <summary>
        /// Exclude <c>_pending/</c> at any depth. Default: <c>false</c> — this is a
        /// LOADER-level primitive, and <c>_pending/</c> is a CLI/pending-promote-workflow
        /// concept (TypeScript's <c>metadata-files.ts</c>, not its loader-level
        /// <c>DirectorySource</c>, which has no <c>_pending</c> concept at all).
        /// <see cref="MetaObjects.Config.SourceResolver"/> — the CLI-facing caller —
        /// turns this ON explicitly rather than the exclusion being baked into every
        /// embedder of this class: an app calling <c>new DirectorySource(dir)</c>
        /// directly gets every file back, matching the reference loader.
        /// </summary>
        public bool ExcludePending { get; init; } = false;
    }

    private static readonly HashSet<string> _supportedExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".json", ".yaml", ".yml" };

    /// Directory excluded at every level of <see cref="Expand"/> — drafts that are
    /// deliberately not part of the loaded model. Mirrors TypeScript's
    /// `PENDING_DIR` in `metadata-files.ts`.
    private const string PendingDir = "_pending";

    /// <summary>The directory being scanned.</summary>
    public string Directory { get; }

    /// <summary>Discovery options.</summary>
    public Options Opts { get; }

    public DirectorySource(string directory, Options? opts = null)
    {
        Directory = directory ?? throw new ArgumentNullException(nameof(directory));
        Opts = opts ?? new Options();
    }

    /// <summary>
    /// Enumerate the matched files as <see cref="FileSource"/> instances, sorted
    /// by full path (ordinal). The sort happens on the full path so that nested
    /// directory traversal is also deterministic.
    /// </summary>
    public IEnumerable<FileSource> Expand()
    {
        IEnumerable<string> files = Collect(Directory, new HashSet<string>(StringComparer.Ordinal))
            .Where(p => _supportedExtensions.Contains(Path.GetExtension(p)));

        if (Opts.ExcludePending)
        {
            // Excludes _pending/ at ANY depth — every ancestor path component
            // between `Directory` and the file is checked, not merely the file's
            // own name, so the whole subtree is skipped. Off by default — see
            // Options.ExcludePending.
            files = files.Where(p => !IsUnderPendingDir(Directory, p));
        }

        if (Opts.Exclude is { Count: > 0 } excludes)
        {
            files = files.Where(p => !excludes.Any(e => MatchesGlob(Path.GetFileName(p), e)));
        }

        return files
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new FileSource(p));
    }

    /// <summary>
    /// The recursive walk behind <see cref="Expand"/>, carrying the REAL
    /// (symlink-resolved) ancestor directories already on this walk branch.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This replaces <c>Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)</c>,
    /// which cannot express the contract. That overload follows directory symlinks —
    /// which is correct and is the cross-port contract — but has no loop guard, and
    /// its <c>EnumerationOptions</c> default of <c>IgnoreInaccessible</c> then SWALLOWS
    /// the kernel's own ELOOP refusal. So a self-referential symlink did not hang and
    /// did not throw: it completed normally, yielding the same real file ~40 times over
    /// at ever-deeper phantom paths. Nothing downstream could recover from that, because
    /// <see cref="MetaObjects.Config.SourceResolver"/> de-duplicates on the LEXICAL full
    /// path and every phantom is lexically distinct — so each one was admitted as its own
    /// source and the same metadata loaded once per level. TypeScript, Java and Python all
    /// raise here; C# was the only port that reported success.
    /// </para>
    /// <para>
    /// Paths are built by lexical join throughout, exactly as the old enumeration built
    /// them — a symlinked directory's OWN name survives in the reported path; only the
    /// WALK resolves the link. <paramref name="ancestors"/> is extended only on the
    /// recursive call and never mutated in place, so it describes the current branch
    /// rather than siblings already visited at the same level: a directory legitimately
    /// reachable through two different symlinks (a diamond, not a cycle) still resolves.
    /// </para>
    /// </remarks>
    /// <exception cref="IOException">A directory symlink revisits a directory already on this branch.</exception>
    private IEnumerable<string> Collect(string directory, HashSet<string> ancestors)
    {
        var real = RealPath(directory);

        if (ancestors.Contains(real))
            throw new IOException(
                $"symlink loop detected while expanding metadata directory: {directory} revisits {real}");

        var nextAncestors = new HashSet<string>(ancestors, StringComparer.Ordinal) { real };

        // Sorted so traversal is deterministic across filesystems, matching the
        // full-path ordinal sort Expand() applies to the result.
        var entries = System.IO.Directory.GetFileSystemEntries(directory);
        Array.Sort(entries, StringComparer.Ordinal);

        foreach (var entry in entries)
        {
            // Directory.Exists follows symlinks, so a symlinked subdirectory is
            // traversed rather than reported as a file — the behaviour the old
            // AllDirectories enumeration had, and the cross-port contract.
            if (System.IO.Directory.Exists(entry))
            {
                if (!Opts.Recurse) continue;
                foreach (var f in Collect(entry, nextAncestors)) yield return f;
            }
            else
            {
                yield return entry;
            }
        }
    }

    /// <summary>
    /// The fully symlink-resolved form of <paramref name="path"/> — .NET's
    /// <c>realpath(3)</c> stand-in, since <see cref="Path.GetFullPath(string)"/> only
    /// normalizes <c>.</c>/<c>..</c> and resolves no links at all.
    /// </summary>
    /// <remarks>
    /// Resolution is component-by-component from the root because
    /// <c>Directory.ResolveLinkTarget</c> canonicalizes ONLY the final segment. Using it
    /// alone would leave a symlinked ANCESTOR unresolved, and the cycle guard would then
    /// compare a half-resolved path against a real one and miss the loop — recursing
    /// forever on exactly the input it exists to catch. Falls back to the lexical path if
    /// the filesystem refuses an answer (the directory vanished mid-walk, or a permission
    /// error): that is the enumeration's problem to report, not this guard's.
    /// </remarks>
    private static string RealPath(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full);
        if (string.IsNullOrEmpty(root)) return full;

        var current = root;
        foreach (var segment in full.Substring(root.Length)
                     .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                            StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            try
            {
                // returnFinalTarget walks a chain of links in one call; the bound is the
                // OS's own, and a link cycle here surfaces as an IOException we fall back on.
                var target = System.IO.Directory.ResolveLinkTarget(current, returnFinalTarget: true)
                             ?? System.IO.File.ResolveLinkTarget(current, returnFinalTarget: true);
                if (target is not null)
                {
                    var t = target.FullName;
                    current = Path.IsPathRooted(t)
                        ? Path.GetFullPath(t)
                        : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(current) ?? root, t));
                }
            }
            catch (IOException) { /* unresolvable — keep the lexical form for this segment */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
        return current;
    }

    /// True when any ancestor path component between <paramref name="root"/> and
    /// <paramref name="filePath"/> (i.e. excluding the file's own name) is
    /// exactly <see cref="PendingDir"/>.
    private static bool IsUnderPendingDir(string root, string filePath)
    {
        var relative = Path.GetRelativePath(root, filePath);
        var dir = Path.GetDirectoryName(relative);
        if (string.IsNullOrEmpty(dir)) return false;
        return dir.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Any(part => part == PendingDir);
    }

    private static bool MatchesGlob(string name, string pattern)
    {
        // Minimal glob: literal match, or single leading '*' / trailing '*' wildcard.
        if (pattern == name) return true;
        if (pattern.StartsWith('*') && name.EndsWith(pattern[1..], StringComparison.Ordinal)) return true;
        if (pattern.EndsWith('*') && name.StartsWith(pattern[..^1], StringComparison.Ordinal)) return true;
        return false;
    }
}
