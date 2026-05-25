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
    }

    private static readonly HashSet<string> _supportedExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".json", ".yaml", ".yml" };

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
        SearchOption search = Opts.Recurse
            ? SearchOption.AllDirectories
            : SearchOption.TopDirectoryOnly;

        IEnumerable<string> files = System.IO.Directory.EnumerateFiles(Directory, "*", search)
            .Where(p => _supportedExtensions.Contains(Path.GetExtension(p)));

        if (Opts.Exclude is { Count: > 0 } excludes)
        {
            files = files.Where(p => !excludes.Any(e => MatchesGlob(Path.GetFileName(p), e)));
        }

        return files
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new FileSource(p));
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
