// Turns a declared source SET (`.metaobjects/config.json`'s `sources`, or the
// single-entry default when it is absent/empty) into a de-duplicated list of
// metadata file paths.
//
// Behavioral contract: server/typescript/packages/sdk/src/sources.ts +
// collection.ts (the cross-port authority). File ORDER is deliberately NOT a
// cross-port contract (each port keeps its own natural order) — only the
// resolved SET and the error behavior are gated by the shared corpus at
// fixtures/source-resolution-conformance/cases.json.
using MetaObjects.Loader;

namespace MetaObjects.Config;

public static class SourceResolver
{
    /// Resolve a declared source SET to a de-duplicated list of metadata files.
    /// A relative `path` resolves against `configDir` — the directory HOLDING the
    /// `.metaobjects/` folder — never against the process working directory.
    ///
    /// Validation runs in two passes, mirroring `sources.ts`'s `orderedPathSpecs`:
    /// EVERY spec's kind is checked first, in declared order, before any spec is
    /// resolved against the filesystem. Interleaving the two (validate-then-resolve
    /// spec by spec) would make which error fires depend on which unsupported spec
    /// or missing path happens to sit first — the corpus pins that an unsupported
    /// KIND anywhere in the list wins over an unresolved PATH regardless of which
    /// is declared first (`unsupported-kind-precedes-unresolved-path-when-path-is-
    /// declared-first`/`-second`).
    public static IReadOnlyList<string> ResolveSources(
        string configDir,
        IReadOnlyList<IReadOnlyDictionary<string, string>> specs)
    {
        // Pass 1 — kind validation across the WHOLE set, no filesystem I/O yet.
        var pathSpecs = new List<string>(specs.Count);
        foreach (var spec in specs)
        {
            if (spec.TryGetValue("path", out var rawPath))
            {
                pathSpecs.Add(rawPath);
            }
            else
            {
                var kind = spec.Keys.FirstOrDefault() ?? "<empty>";
                throw new MetaModelException(
                    $"source kind \"{kind}\" is not supported by this toolchain yet; use a \"path\" source",
                    ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED);
            }
        }

        // Pass 2 — resolve each validated path spec against the filesystem.
        var seen = new List<string>();
        var known = new HashSet<string>(StringComparer.Ordinal);

        foreach (var rawPath in pathSpecs)
        {
            var target = Path.IsPathRooted(rawPath) ? rawPath : Path.GetFullPath(Path.Combine(configDir, rawPath));

            var isDir = Directory.Exists(target);
            if (!isDir && !File.Exists(target))
                throw new MetaModelException(
                    $"source path \"{rawPath}\" does not exist (resolved to {target}, relative to {configDir})",
                    ErrorCode.ERR_SOURCE_UNRESOLVED);

            // Directory expansion — extension filter + ordinal sort — is
            // DirectorySource's, the SAME code the loader itself uses to turn a
            // directory into metadata files (Loader/DirectorySource.cs). Reimplementing
            // the filter/sort here would be a second, driftable definition of "which
            // files count as metadata" for exactly the reason DirectorySource's own
            // header calls out: order within one directory spec is this port's own
            // full-path ordinal sort, deliberately NOT a cross-port contract (see the
            // file header above), but it MUST still be the loader's own order.
            // ExcludePending = true: this IS the CLI-facing resolver — `_pending/` is
            // the TypeScript CLI's pending/promote-workflow concept, not a loader
            // concept, so the loader-level default (off) is overridden here, the one
            // place this port's CLI turns it on.
            var found = isDir
                ? new DirectorySource(target, new DirectorySource.Options { ExcludePending = true })
                    .Expand().Select(f => f.FilePath)
                : new[] { target }.AsEnumerable();

            foreach (var f in found)
            {
                var full = Path.GetFullPath(f);
                if (known.Add(full)) seen.Add(full);
            }
        }

        return seen;
    }

    /// The full ladder: declared `sources`, else the default directory.
    /// Only the DEFAULT may be silently absent — a declared source that does not
    /// resolve is `ERR_SOURCE_UNRESOLVED`, a louder failure than "nothing declared".
    public static IReadOnlyList<string> ResolveCollection(string root)
    {
        root = Path.GetFullPath(root);
        var cfg = NeutralConfig.Read(root);
        var specs = cfg?.Sources ?? Array.Empty<IReadOnlyDictionary<string, string>>();

        if (specs.Count == 0)
        {
            var defaultDir = Path.Combine(root, NeutralConfig.DefaultMetadataDir);
            if (!Directory.Exists(defaultDir))
                throw new MetaModelException(
                    $"no metadata sources declared in {root} and no default \"{NeutralConfig.DefaultMetadataDir}\" " +
                    "directory found. Declare \"sources\" in .metaobjects/config.json, or run 'meta init' to scaffold.",
                    ErrorCode.ERR_COLLECTION_NOT_FOUND);
            specs = new IReadOnlyDictionary<string, string>[]
            {
                new Dictionary<string, string> { ["path"] = NeutralConfig.DefaultMetadataDir },
            };
        }

        return ResolveSources(root, specs);
    }
}
