using System.Text.Json;
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
    /// Library name to its manifest's LAYERS: layer token to that layer's ordered refs.
    /// The CORE layer's token is the empty string.
    /// </summary>
    /// <remarks>
    /// Read from the embedded <c>library.json</c> manifests, not derived from the ref names.
    /// This used to be package-granular — every ref under a library came back for a bare
    /// <c>"ai"</c> — which under the layered design (FR-043 Amendment 1) would hand an adopter
    /// the db layer they did not ask for, and with it a migration proposing tables.
    /// </remarks>
    private static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>> LayersByLibrary =
        BuildLayers();

    /// <summary>Resolved once per process; null means "looked, not present".</summary>
    private static readonly Lazy<string?> LibraryDir = new(LibraryDirOnDisk);

    private static IReadOnlyDictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>> BuildLayers()
    {
        var map = new Dictionary<string, IReadOnlyDictionary<string, IReadOnlyList<string>>>(StringComparer.Ordinal);
        foreach (var (name, text) in EmbeddedLibrary.Manifests.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            using var doc = JsonDocument.Parse(text);
            var layers = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            if (doc.RootElement.TryGetProperty("layers", out var layersEl))
            {
                foreach (var layer in layersEl.EnumerateObject())
                {
                    var refs = new List<string>();
                    if (layer.Value.TryGetProperty("refs", out var refsEl))
                    {
                        foreach (var r in refsEl.EnumerateArray())
                        {
                            if (r.GetString() is { } s) refs.Add(s);
                        }
                    }
                    layers[layer.Name] = refs;
                }
            }
            map[name] = layers;
        }
        return map;
    }

    /// <summary>
    /// Split a selection token into library and layer — <c>"iam"</c> to <c>("iam", "")</c>,
    /// <c>"iam/db"</c> to <c>("iam", "db")</c>. Only the FIRST separator is meaningful, so a
    /// typo stays a typo rather than resolving to a prefix.
    /// </summary>
    public static (string Library, string Layer) SplitToken(string token)
    {
        var i = token.IndexOf('/');
        return i == -1 ? (token, "") : (token[..i], token[(i + 1)..]);
    }

    /// <summary>Every selection token this build accepts, sorted — what a config error prints.</summary>
    /// <summary>The prefix every library source id carries.</summary>
    public const string LibraryFileIdPrefix = "library:";

    /// <summary>
    /// The source id a library file loads under, in every build —
    /// <c>library:iam/model.yaml</c>.
    /// </summary>
    /// <remarks>
    /// Stable rather than path-derived so a library node's ADR-0009 provenance envelope
    /// reads the same from a checkout and from an installed package, carries no absolute
    /// path, and cannot be confused with an adopter file sharing a basename.
    /// </remarks>
    public static string LibraryFileId(string reference) => $"{LibraryFileIdPrefix}{reference}.yaml";

    public static IReadOnlyList<string> KnownTokens() =>
        LayersByLibrary
            .SelectMany(kv => kv.Value.Keys.Select(layer => layer.Length == 0 ? kv.Key : $"{kv.Key}/{layer}"))
            .OrderBy(t => t, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// The library package names this build ships, sorted.
    ///
    /// <para><see cref="Resolve"/> deliberately skips an unrecognised name (see there), so a
    /// typo would otherwise surface only as <c>ERR_UNRESOLVED_SUPER</c> against the adopter's
    /// own metadata — the wrong place to go looking. A caller that took the name from a human
    /// validates against this first.</para>
    /// </summary>
    public static IReadOnlyList<string> KnownPackages() =>
        LayersByLibrary.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();

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
    /// <param name="packages">Selection tokens (e.g. <c>["iam", "iam/db"]</c>); null yields none.</param>
    public static List<IMetaDataSource> Resolve(IEnumerable<string>? packages)
    {
        var outSources = new List<IMetaDataSource>();
        if (packages is null) return outSources;

        // A token whose LAYER is unknown is dropped whole, not reduced to its core: implying
        // the core from an invalid layer would answer a mistyped "iam/database" with an inert
        // core and no tables, which is the worst of the available outcomes.
        var wanted = packages
            .Select(SplitToken)
            .Where(t => LayersByLibrary.TryGetValue(t.Library, out var l) && l.ContainsKey(t.Layer))
            .ToList();

        // Core layers FIRST, across every requested library, so a db layer named before its
        // core in the config still parses after it. "iam/db" IMPLIES "iam": a db layer is
        // nothing but overlay:true redeclarations, and an overlay whose target was never
        // declared is ERR_OVERLAY_NO_TARGET.
        var refs = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string r) { if (seen.Add(r)) refs.Add(r); }
        foreach (var (lib, _) in wanted)
        {
            foreach (var r in LayersByLibrary[lib][""]) Add(r);
        }
        foreach (var (lib, layer) in wanted)
        {
            if (layer.Length == 0) continue;
            foreach (var r in LayersByLibrary[lib][layer]) Add(r);
        }

        var dir = LibraryDir.Value;
        {
            foreach (var r in refs)
            {
                if (dir is not null)
                {
                    var path = Path.Combine(dir, r.Replace('/', Path.DirectorySeparatorChar) + ".yaml");
                    if (File.Exists(path))
                    {
                        // The SAME id the embedded branch below uses — see LibraryFileId.
                        outSources.Add(new FileSource(path, LibraryFileId(r)));
                        continue;
                    }
                }
                if (!EmbeddedLibrary.Content.TryGetValue(r, out var embedded))
                {
                    throw new InvalidOperationException(
                        $"library ref \"{r}\" has no on-disk file and no "
                        + "embedded entry — the embedded library class is stale; run "
                        + "scripts/generate-embedded-library.ts");
                }
                outSources.Add(new InMemoryStringSource(
                    embedded, LibraryFileId(r), MetaDataFormat.Yaml));
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
