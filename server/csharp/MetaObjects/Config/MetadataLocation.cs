// Where a command's metadata comes from: the one ladder every C# entry point uses.
//
// `dotnet meta gen`/`verify`/`docs` and an ejected codegen/Program.cs (via
// MetaObjects.Codegen.CodegenCli) all resolve metadata through Resolve below. It lives in
// the core package because an ejected project references only MetaObjects.Codegen, never
// MetaObjects.Cli; while the ladder lived in the CLI, the owned runner loaded a bare
// directory and lost `.metaobjects/config.json`'s `libraries`, so a project that opts
// into a library could not regenerate at all once it ejected a generator.

using MetaObjects.Loader;

namespace MetaObjects.Config;

/// <summary>
/// The metadata-location ladder's result: always a directory (the explicit argument, or
/// the single declared source), and — when resolution went through
/// <c>.metaobjects/config.json</c> rather than an explicit argument — the ladder's own
/// already-resolved, <c>_pending</c>-excluded file list too. <see cref="Load"/> uses that
/// list when present: <c>FromDirectory</c> would re-walk the tree AND include
/// <c>_pending</c> drafts, since only <see cref="SourceResolver"/> turns that exclusion on.
/// </summary>
public sealed record ResolvedMetadata(string Directory, IReadOnlyList<string>? Files, IReadOnlyList<string> Libraries)
{
    /// <summary>Load this metadata, with the project's <c>libraries</c>.</summary>
    public LoadResult Load(bool strict = false) => Files is { } files
        ? MetaDataLoader.FromUris(files.Select(f => new Uri(f)).ToList(), Libraries, strict)
        : MetaDataLoader.FromDirectory(Directory, Libraries, strict: strict);
}

/// <summary>A metadata location this port cannot load, stated for the user.</summary>
public sealed class MetadataLocationException(string message) : Exception(message);

public static class MetadataLocation
{
    /// <summary>
    /// The project a metadata directory belongs to: its PARENT, the directory holding
    /// <c>metaobjects/</c> and <c>.metaobjects/</c>.
    /// </summary>
    public static string ProjectRootFor(string metadataDir) =>
        Path.GetDirectoryName(Path.GetFullPath(metadataDir)) ?? System.IO.Directory.GetCurrentDirectory();

    /// <summary>
    /// Resolve where metadata lives. An explicit <paramref name="metadataDir"/> is used as
    /// given; otherwise <paramref name="cwd"/>'s <c>.metaobjects/config.json</c>
    /// <c>sources</c> (or the default directory) decides. <c>libraries</c> is read from the
    /// port-neutral config on BOTH paths — for an explicit directory, from the project that
    /// holds it. Throws <see cref="MetaModelException"/> for a malformed config or an
    /// unresolvable source, and <see cref="MetadataLocationException"/> for a source shape
    /// this port's loader cannot take (several sources, or a file).
    /// </summary>
    public static ResolvedMetadata Resolve(string? metadataDir, string cwd)
    {
        if (metadataDir is not null)
        {
            var explicitLibs = NeutralConfig.Read(ProjectRootFor(metadataDir))?.Libraries ?? Array.Empty<string>();
            return new ResolvedMetadata(metadataDir, null, explicitLibs);
        }

        var cfg = NeutralConfig.Read(cwd);
        var specs = cfg?.Sources ?? Array.Empty<IReadOnlyDictionary<string, string>>();
        var libraries = cfg?.Libraries ?? Array.Empty<string>();

        if (specs.Count == 0)
        {
            // No declared sources: resolve the DEFAULT directory through the same ladder
            // the shared conformance corpus gates (ERR_COLLECTION_NOT_FOUND when absent).
            var defaultFiles = SourceResolver.ResolveCollection(cwd);
            return new ResolvedMetadata(Path.Combine(cwd, NeutralConfig.DefaultMetadataDir), defaultFiles, libraries);
        }

        if (specs.Count > 1)
        {
            // MetaDataLoader.FromDirectory takes ONE directory; refuse rather than load
            // just one of the declared sources. MetaDataLoader.Load(IReadOnlyList<IMetaDataSource>)
            // is the documented follow-up that lifts this.
            throw new MetadataLocationException(
                $"{cwd}: .metaobjects/config.json declares {specs.Count} metadata sources, but " +
                "this CLI's loader accepts only one directory at a time. Pass <metadataDir> explicitly, " +
                "or reduce \"sources\" to a single entry.");
        }

        // Exactly one declared source. ResolveSources validates it (ERR_SOURCE_KIND_UNSUPPORTED /
        // ERR_SOURCE_UNRESOLVED) and returns the `_pending`-excluded file list to load.
        var files = SourceResolver.ResolveSources(cwd, specs);
        var rawPath = specs[0]["path"]; // present: ResolveSources would have thrown otherwise
        var resolved = Path.IsPathRooted(rawPath) ? rawPath : Path.GetFullPath(Path.Combine(cwd, rawPath));

        if (!System.IO.Directory.Exists(resolved))
        {
            // ResolveSources proved `resolved` exists, so it is a FILE, which
            // FromDirectory would fail on with an opaque ERR_UNKNOWN.
            throw new MetadataLocationException(
                $"{cwd}: .metaobjects/config.json's single \"sources\" entry (\"{rawPath}\") is a FILE, " +
                "but this CLI's loader only accepts a directory source. Pass <metadataDir> explicitly, or point " +
                "\"sources\" at the file's containing directory.");
        }

        return new ResolvedMetadata(resolved, files, libraries);
    }
}
