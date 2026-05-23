// FileMetaDataLoader — thin subclass that DISCOVERS file-backed sources and
// delegates all merge/parse logic to MetaDataLoader.Load().
//
// Ported from typescript/packages/metadata/src/loader/core/file-meta-data-loader.ts
// and cross-referenced with Java H3a MetaDataLoader + FileMetaDataLoader.

using MetaObjects.Meta;

namespace MetaObjects.Loader;

/// <summary>
/// Extends <see cref="MetaDataLoader"/> with filesystem source discovery.
/// Adds <see cref="LoadFiles"/> and <see cref="LoadDirectory"/> — both delegate
/// to <see cref="MetaDataLoader.Load"/> once sources are built.
/// </summary>
public class FileMetaDataLoader : MetaDataLoader
{
    // -------------------------------------------------------------------------
    // Constructors — forward to base
    // -------------------------------------------------------------------------

    public FileMetaDataLoader()
        : base() { }

    public FileMetaDataLoader(TypeRegistry registry)
        : base(registry) { }

    public FileMetaDataLoader(TypeRegistry registry, bool freeze = true, bool strict = false)
        : base(registry, freeze, strict) { }

    // -------------------------------------------------------------------------
    // LoadFiles — build FileSource per path, delegate to Load()
    // -------------------------------------------------------------------------

    /// <summary>
    /// Load metadata from the given file paths. Each path becomes a
    /// <see cref="FileSource"/>; all sources are passed to
    /// <see cref="MetaDataLoader.Load"/> in the order supplied.
    /// </summary>
    public LoadResult LoadFiles(IReadOnlyList<string> paths)
    {
        var sources = paths
            .Select(p => (IMetaDataSource)new FileSource(p))
            .ToList();
        return Load(sources);
    }

    // -------------------------------------------------------------------------
    // LoadDirectory — discover *.json / *.yaml / *.yml, sort, delegate
    // -------------------------------------------------------------------------

    /// <summary>
    /// Discover all JSON/YAML metadata files in <paramref name="dir"/>, sort them
    /// deterministically by filename (ordinal), build <see cref="FileSource"/>s,
    /// and delegate to <see cref="MetaDataLoader.Load"/>.
    /// <para>
    /// A directory-read failure is surfaced as a collected <see cref="MetaError"/>
    /// on a synthetic empty root (mirrors the TS empty-source path where Load([])
    /// returns a synthetic root).
    /// </para>
    /// </summary>
    public LoadResult LoadDirectory(string dir)
    {
        string[] files;
        try
        {
            files = Directory.GetFiles(dir, "*", SearchOption.TopDirectoryOnly)
                .Where(f =>
                {
                    string ext = Path.GetExtension(f);
                    return ext.Equals(".json", StringComparison.OrdinalIgnoreCase)
                           || ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase)
                           || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase);
                })
                .OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal)
                .ToArray();
        }
        catch (Exception ex)
        {
            // The directory-read failed before any source was discovered. Return a
            // synthetic empty root with the I/O error collected; transition State to
            // "error" so the post-load contract is satisfied.
            SetState("error");
            var emptyRoot = new MetaRoot(
                new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
            if (Freeze) emptyRoot.Freeze();
            var dirError = new MetaError(
                $"Failed to read directory \"{dir}\": {ex.Message}",
                ErrorCode.ERR_UNKNOWN);
            return new LoadResult(emptyRoot, [], [dirError]);
        }

        var sources = files
            .Select(f => (IMetaDataSource)new FileSource(f))
            .ToList();

        return Load(sources);
    }
}
