using MetaObjects.Loader;

namespace MetaObjects.Library;

/// <summary>
/// Resolves <see cref="IMetaDataSource"/> instances for the MetaObjects-shipped library
/// packages.
///
/// <para>Cross-port parity with the TypeScript <c>library-sources.ts</c>, the Python
/// <c>library_sources.py</c> and the Java <c>LibrarySources</c>: same package names, same
/// refs, same resolution order.</para>
///
/// <para><b>On-disk first</b> — when the repo-root <c>library/</c> tree is reachable (a dev
/// checkout, or an installed-from-source layout) a <see cref="FileSource"/> is returned, so
/// edits to the canonical YAML are picked up without regenerating anything. <b>Embedded
/// fallback</b> — when that directory is absent, which is every consumer of the published
/// package, the content baked into <see cref="EmbeddedLibrary"/> is used instead.</para>
/// </summary>
public static class LibrarySources
{
    /// <summary>
    /// Package to ordered refs, derived from the generated embed so that adding a library file
    /// (which regenerates <see cref="EmbeddedLibrary"/>) needs no edit here.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> RefsByPackage =
        BuildRefsByPackage();

    /// <summary>Resolved once per process; null means "looked, not present".</summary>
    private static readonly Lazy<string?> LibraryDir = new(LibraryDirOnDisk);

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> BuildRefsByPackage()
    {
        var map = new Dictionary<string, List<string>>();
        foreach (var r in EmbeddedLibrary.Content.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var slash = r.IndexOf('/');
            if (slash <= 0) continue;
            var pkg = r[..slash];
            if (!map.TryGetValue(pkg, out var list))
            {
                list = [];
                map[pkg] = list;
            }
            list.Add(r);
        }
        return map.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value);
    }

    /// <summary>
    /// The library package names this build ships, sorted.
    ///
    /// <para><see cref="Resolve"/> deliberately skips an unrecognised name (see there), so a
    /// typo would otherwise surface only as <c>ERR_UNRESOLVED_SUPER</c> against the adopter's
    /// own metadata — the wrong place to go looking. A caller that took the name from a human
    /// validates against this first.</para>
    /// </summary>
    public static IReadOnlyList<string> KnownPackages() =>
        RefsByPackage.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();

    /// <summary>
    /// Locate the repo-root <c>library/</c> directory by walking up from this assembly's
    /// location until a directory contains BOTH <c>library/</c> and <c>server/</c> — the two
    /// structural anchors that identify the repo root. Null when it is not reachable.
    /// </summary>
    private static string? LibraryDirOnDisk()
    {
        var dir = AppContext.BaseDirectory;
        for (var d = new DirectoryInfo(dir); d is not null; d = d.Parent)
        {
            if (Directory.Exists(Path.Combine(d.FullName, "library"))
                && Directory.Exists(Path.Combine(d.FullName, "server")))
            {
                return Path.Combine(d.FullName, "library");
            }
        }
        return null;
    }

    /// <summary>
    /// Sources for the requested library packages, in ref order.
    ///
    /// <para>An unrecognised package contributes NO sources and is not an error here. That is
    /// deliberate and matches every other port: a programmatic caller asking for a package this
    /// version does not ship should still be able to load its own metadata. A name a human
    /// typed into a config file is the opposite case, and the caller that read it validates
    /// against <see cref="KnownPackages"/> before calling this.</para>
    /// </summary>
    /// <param name="packages">Package names to include (e.g. <c>["ai"]</c>); null yields none.</param>
    public static List<IMetaDataSource> Resolve(IEnumerable<string>? packages)
    {
        var outSources = new List<IMetaDataSource>();
        if (packages is null) return outSources;

        var dir = LibraryDir.Value;
        foreach (var pkg in packages)
        {
            if (!RefsByPackage.TryGetValue(pkg, out var refs)) continue; // unknown — no sources

            foreach (var r in refs)
            {
                if (dir is not null)
                {
                    var path = Path.Combine(dir, r.Replace('/', Path.DirectorySeparatorChar) + ".yaml");
                    if (File.Exists(path))
                    {
                        outSources.Add(new FileSource(path));
                        continue;
                    }
                }
                if (!EmbeddedLibrary.Content.TryGetValue(r, out var embedded))
                {
                    throw new InvalidOperationException(
                        $"library ref \"{r}\" (package \"{pkg}\") has no on-disk file and no "
                        + "embedded entry — the embedded library class is stale; run "
                        + "scripts/generate-embedded-library.ts");
                }
                outSources.Add(new InMemoryStringSource(
                    embedded, $"library:{r}.yaml", MetaDataFormat.Yaml));
            }
        }
        return outSources;
    }

    /// <summary>
    /// The canonical on-disk content for a ref, when the repo-root <c>library/</c> tree is
    /// reachable. Exists for the freshness gate, which has to compare the embed against the
    /// source of truth rather than against itself. Null when the tree is unreachable.
    /// </summary>
    public static string? OnDiskContent(string reference)
    {
        var dir = LibraryDir.Value;
        if (dir is null) return null;
        var path = Path.Combine(dir, reference.Replace('/', Path.DirectorySeparatorChar) + ".yaml");
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
