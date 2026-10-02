// `dotnet meta fmt` — rewrite metadata files into the canonical form the
// cross-port canonical serializer already produces (#304). `--check` lists
// files that are not canonical and exits non-zero without changing anything.
//
// Mirrors the TS reference (server/typescript/packages/metadata/src/fmt.ts +
// server/typescript/packages/cli/src/lib/fmt-engine.ts) exactly:
//
//   - Each file is formatted STANDALONE — own-mode, declared-here layer only
//     (ADR-0039). Never merged with its siblings: an `extends` onto another
//     file's base is preserved as the raw ref string (super resolution is
//     deferred and never run here), and an `overlay: true` declaration with
//     no base in the SAME file surfaces as ERR_OVERLAY_NO_TARGET — reported
//     as a skip rather than guessed at.
//   - YAML is always skipped: no canonical YAML emitter exists (ADR-0006).
//   - Before writing, the WHOLE project is reloaded with the candidate
//     substituted in (an InMemoryStringSource carrying the real file's id)
//     and the write is refused unless that reload has no errors AND its
//     canonical serialization is byte-identical to the untouched baseline.

using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Library;

namespace MetaObjects.Cli;

/// <summary>The fmt command's pure logic — no console I/O, so it is testable.</summary>
public static class FmtCommand
{
    public enum FileStatus { Formatted, WouldFormat, Unchanged, SkippedYaml, SkippedOverlay, Error }

    public sealed record FileReport(string Path, FileStatus Status, string? Detail = null);

    /// <summary>Everything a run produced. <see cref="Fatal"/> set means nothing was
    /// attempted — an unresolvable location, an explicit file outside the resolved
    /// sources, or metadata that does not currently load cleanly.</summary>
    public sealed record RunResult(IReadOnlyList<FileReport> Files, string? Fatal = null);

    public sealed record FormatFileResult(bool Ok, bool Overlay, string? Text, string? Message);

    /// <summary>
    /// Format one file's own content. Parses <paramref name="content"/> standalone
    /// (no <c>IntoRoot</c> — never merged with any other file) and, on a clean parse,
    /// returns the canonical serialization of the resulting file root. Never throws.
    /// </summary>
    public static FormatFileResult FormatFile(string content, TypeRegistry registry, string sourceId, bool strict = false)
    {
        ParseResult result;
        try
        {
            result = Parser.ParseJson(content, new ParseOptions(registry)
            {
                Strict = strict,
                SourceName = sourceId,
                // Never resolved here — a cross-file `extends` must not become an
                // error just because this file is formatted in isolation.
                DeferSuperResolution = true,
            });
        }
        catch (ParseException ex)
        {
            return new FormatFileResult(false, false, null, ex.Message);
        }

        if (result.Errors.Count > 0)
        {
            bool overlay = result.Errors.Any(e => e.Code == ErrorCode.ERR_OVERLAY_NO_TARGET);
            return new FormatFileResult(false, overlay, null, string.Join("; ", result.Errors.Select(e => e.Message)));
        }

        return new FormatFileResult(true, false, SerializerJson.CanonicalSerialize(result.Root), null);
    }

    /// <summary>
    /// Resolve the target file list: <see cref="ResolvedMetadata.Files"/> when the
    /// project's <c>.metaobjects/config.json</c> ladder already resolved one, else a
    /// fresh <see cref="DirectorySource"/> walk of <see cref="ResolvedMetadata.Directory"/>
    /// (ExcludePending, matching every other command's load path).
    /// </summary>
    public static IReadOnlyList<string> ResolveAllFiles(ResolvedMetadata resolved) =>
        resolved.Files ?? new DirectorySource(resolved.Directory, new DirectorySource.Options { ExcludePending = true })
            .Expand().Select(f => f.FilePath).ToList();

    public static RunResult Run(ResolvedMetadata resolved, bool check, IReadOnlyList<string>? explicitFiles = null, bool strict = false)
    {
        IReadOnlyList<string> allFiles = ResolveAllFiles(resolved);

        IReadOnlyList<string> targets;
        if (explicitFiles is { Count: > 0 })
        {
            var owned = allFiles.Select(Path.GetFullPath).ToHashSet();
            var want = explicitFiles.Select(Path.GetFullPath).ToList();
            var missing = want.Where(f => !owned.Contains(f)).ToList();
            if (missing.Count > 0)
            {
                return new RunResult(Array.Empty<FileReport>(),
                    "not among this project's resolved metadata sources: " + string.Join(", ", missing) +
                    "\nmeta fmt only formats files the metadata-location ladder already resolves — " +
                    "pass no arguments to format every one of them.");
            }
            var wantSet = want.ToHashSet();
            targets = allFiles.Where(f => wantSet.Contains(Path.GetFullPath(f))).ToList();
        }
        else
        {
            targets = allFiles;
        }

        var registry = new MetaDataLoader().Registry;

        List<IMetaDataSource> BuildSources(string? overridePath = null, string? overrideText = null)
        {
            var sources = new List<IMetaDataSource>(LibrarySources.Resolve(resolved.Libraries));
            foreach (var p in allFiles)
            {
                sources.Add(overridePath is not null && p == overridePath
                    ? new InMemoryStringSource(overrideText ?? "", Path.GetFileName(p))
                    : new FileSource(p));
            }
            return sources;
        }

        var baseline = new MetaDataLoader(registry).Load(BuildSources());
        if (baseline.Errors.Count > 0)
        {
            return new RunResult(Array.Empty<FileReport>(),
                "this project's metadata does not currently load cleanly — fix the error(s) below, " +
                "then re-run fmt:\n" + string.Join("\n", baseline.Errors.Select(e => $"  {e.Message}")));
        }
        var baselineCanonical = SerializerJson.CanonicalSerialize(baseline.Root);

        var reports = new List<FileReport>();
        foreach (var path in targets)
        {
            var ext = Path.GetExtension(path);
            if (ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase) || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase))
            {
                reports.Add(new FileReport(path, FileStatus.SkippedYaml,
                    "no canonical YAML emitter exists (ADR-0006: JSON is the canonical interchange form) — left untouched"));
                continue;
            }

            var content = File.ReadAllText(path);
            var formatted = FormatFile(content, registry, Path.GetFileName(path), strict);
            if (!formatted.Ok)
            {
                reports.Add(new FileReport(path,
                    formatted.Overlay ? FileStatus.SkippedOverlay : FileStatus.Error,
                    formatted.Message));
                continue;
            }

            if (formatted.Text == content)
            {
                reports.Add(new FileReport(path, FileStatus.Unchanged));
                continue;
            }

            var testLoad = new MetaDataLoader(registry).Load(BuildSources(path, formatted.Text));
            bool safe = testLoad.Errors.Count == 0 && SerializerJson.CanonicalSerialize(testLoad.Root) == baselineCanonical;
            if (!safe)
            {
                reports.Add(new FileReport(path, FileStatus.Error,
                    "formatting this file would change the loaded model's meaning — left unchanged"));
                continue;
            }

            if (check)
            {
                reports.Add(new FileReport(path, FileStatus.WouldFormat));
            }
            else
            {
                File.WriteAllText(path, formatted.Text!);
                reports.Add(new FileReport(path, FileStatus.Formatted));
            }
        }

        return new RunResult(reports);
    }
}
