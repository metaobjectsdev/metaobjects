// FR-023 Phase 2 — the upstream dependency check behind `dotnet meta verify --deps`.
//
// For each declared dependency: resolve its `path`, read and validate the publisher's
// `metaobjects.pkg.json`, hash the artifact beside it, and compare with the lock. Mirrors the
// TypeScript `checkDependencies` (cli/src/lib/dependency-sync.ts) and the Python
// `check_dependencies`, and is gated by the `expectCheck` arm of fixtures/dependency-conformance/.
//
// A pure function of the config, the lock and the publisher's directory: it writes nothing and
// loads nothing. The Node `meta deps sync` (the only writer of the lock and the snapshot) is what
// repairs a drift this reports.
//
// Only the `path` transport is resolved here. An `npm` / `python` dependency is resolved through
// the consumer's installed packages, which only the Node toolchain reads, so this port reports it
// `Unresolved` and names `meta deps check`: a check that cannot check must not pass.
using System.Text.Json;

namespace MetaObjects.Config;

/// <summary>The verdict for one declared dependency.</summary>
public enum DependencyCheckStatus
{
    /// <summary>It resolves and hashes to the lock's <c>integrity</c> (a new <c>version</c> over the same bytes is still current).</summary>
    Current,

    /// <summary>It resolves, but hashes to something other than the lock records.</summary>
    Drifted,

    /// <summary>The check cannot compare: no directory, no or invalid manifest, a missing or mismatching artifact, or no lock entry.</summary>
    Unresolved,
}

/// <summary>One declared dependency's check result. <c>Lock*</c> are null exactly when the lock has no entry for it; <c>Installed*</c> are null exactly when resolution failed; <c>Detail</c> is the reason, for <c>Unresolved</c> only.</summary>
public sealed record DependencyCheckResult(
    string Name, DependencyCheckStatus Status, string? LockVersion, string? LockIntegrity,
    string? InstalledVersion, string? InstalledIntegrity, string? Detail)
{
    /// <summary>The lowercase status name the corpus and the report use.</summary>
    public string StatusName => Status.ToString().ToLowerInvariant();
}

public static partial class DependencyResolver
{
    private static readonly string[] ManifestKeys =
        ["schema_version", "name", "version", "metamodelVersion", "artifact", "integrity", "packages", "nodes"];

    /// <summary>The publisher's manifest file, beside its artifact.</summary>
    public const string ManifestFile = "metaobjects.pkg.json";

    private sealed class UnresolvedException(string message) : Exception(message);

    private static UnresolvedException ManifestInvalid(string detail) => new(detail);

    /// <summary>The first 8 hex digits of an <c>sha256-&lt;hex&gt;</c> integrity, the report's short form.</summary>
    public static string Hash8(string integrity) =>
        integrity.Length >= DependencyFiles.IntegrityPrefix.Length + 8
            ? integrity.Substring(DependencyFiles.IntegrityPrefix.Length, 8)
            : integrity;

    /// <summary>
    /// Validate a parsed <c>metaobjects.pkg.json</c> (DESIGN §3.2): the known keys only, a
    /// <c>schema_version</c> of 1, a valid <c>name</c>, <c>version</c>, <c>metamodelVersion</c>,
    /// <c>artifact</c> and <c>integrity</c>, and sorted <c>packages</c> / <c>nodes</c>. Returns the artifact
    /// file name and its recorded integrity and version; anything else is a reason string.
    /// </summary>
    private static (string Version, string Artifact, string Integrity) ValidateManifest(JsonElement root, string manifestPath)
    {
        UnresolvedException Fail(string reason) =>
            ManifestInvalid($"{manifestPath} failed schema validation — {reason}");

        if (root.ValueKind != JsonValueKind.Object) throw Fail("must be an object");

        var extra = root.EnumerateObject().Select(p => p.Name).Where(n => !ManifestKeys.Contains(n))
            .Order(StringComparer.Ordinal).ToList();
        if (extra.Count > 0) throw Fail($"unknown key(s): [{string.Join(", ", extra)}]");

        if (!root.TryGetProperty("schema_version", out var sv) || sv.ValueKind != JsonValueKind.Number ||
            !sv.TryGetDouble(out var schemaVersion) || schemaVersion != 1)
            throw Fail("\"schema_version\" must be 1");

        string Str(string field, string what)
        {
            if (!root.TryGetProperty(field, out var el) || el.ValueKind != JsonValueKind.String ||
                string.IsNullOrEmpty(el.GetString()))
                throw Fail($"\"{field}\" must be {what}");
            return el.GetString()!;
        }

        if (!NameRe.IsMatch(Str("name", "a string matching ^[a-z0-9][a-z0-9._-]*$")))
            throw Fail("\"name\" must match ^[a-z0-9][a-z0-9._-]*$");
        var version = Str("version", "a non-empty string");
        if (!MetamodelVersionRe.IsMatch(Str("metamodelVersion", "a string matching ^\\d+\\.\\d+$")))
            throw Fail("\"metamodelVersion\" must match ^\\d+\\.\\d+$");
        var artifact = Str("artifact", $"a string ending with '{DependencyFiles.ArtifactSuffix}'");
        if (!artifact.EndsWith(DependencyFiles.ArtifactSuffix, StringComparison.Ordinal))
            throw Fail($"\"artifact\" must end with '{DependencyFiles.ArtifactSuffix}'");
        var integrity = Str("integrity", "a string matching ^sha256-[0-9a-f]{64}$");
        if (!IntegrityRe.IsMatch(integrity)) throw Fail("\"integrity\" must match ^sha256-[0-9a-f]{64}$");

        foreach (var field in new[] { "packages", "nodes" })
        {
            if (!root.TryGetProperty(field, out var el) || el.ValueKind != JsonValueKind.Array ||
                el.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String || v.GetString()!.Length == 0))
                throw Fail($"\"{field}\" must be an array of non-empty strings");
            if (!IsStrictlyAscending(el.EnumerateArray().Select(v => v.GetString()!).ToList()))
                throw Fail($"\"{field}\" must be sorted");
        }

        return (version, artifact, integrity);
    }

    /// <summary>
    /// <c>&lt;dir&gt;/metaobjects.pkg.json</c>, strict, plus the artifact bytes beside it, verified to hash
    /// to the manifest's own <c>integrity</c> (a publisher who bypassed <c>sharedModelFile()</c> is caught here).
    /// </summary>
    private static (string Version, byte[] Artifact) ReadManifestDir(string dir)
    {
        var manifestPath = Path.Combine(dir, ManifestFile);
        string raw;
        try
        {
            raw = File.ReadAllText(manifestPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw ManifestInvalid($"no {ManifestFile} found at {manifestPath}");
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(raw);
        }
        catch (JsonException e)
        {
            throw ManifestInvalid($"{manifestPath} is not valid JSON: {e.Message}");
        }

        using (doc)
        {
            var (version, artifact, integrity) = ValidateManifest(doc.RootElement, manifestPath);
            var artifactPath = Path.Combine(dir, artifact);
            byte[] data;
            try
            {
                data = File.ReadAllBytes(artifactPath);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw ManifestInvalid($"the manifest names artifact \"{artifact}\", but it is missing at {artifactPath}");
            }

            var actual = Sha256Integrity(data);
            if (actual != integrity)
                throw ManifestInvalid($"{artifactPath} hashes to {actual}, but the manifest records {integrity}");
            return (version, data);
        }
    }

    private static string ResolveDependencyDir(string configDir, DependencySpec spec)
    {
        if (spec.Transport != "path")
            throw new UnresolvedException(
                $"the \"{spec.Transport}\" transport is resolved by the Node toolchain; " +
                "run `meta deps check` to check this dependency");
        var target = Path.GetFullPath(Path.Combine(configDir, spec.Location));
        if (!Directory.Exists(target))
            throw new UnresolvedException($"the \"path\" transport resolved to {target}, but no directory exists there");
        return target;
    }

    /// <summary>
    /// Resolve each declared dependency and compare its artifact's TRUE hash (re-hashed from the bytes
    /// on disk, never the manifest's own field taken on faith) with the lock's. Read-only. One result
    /// per declared dependency, in name order. A null <paramref name="lockEntries"/> (no lock file) makes
    /// every dependency <c>Unresolved</c>: there is nothing to compare against.
    /// </summary>
    public static IReadOnlyList<DependencyCheckResult> CheckDependencies(
        string configDir, IReadOnlyList<DependencySpec> specs,
        IReadOnlyDictionary<string, DependencyLockEntry>? lockEntries)
    {
        var results = new List<DependencyCheckResult>();
        foreach (var spec in specs.OrderBy(s => s.Name, StringComparer.Ordinal))
        {
            DependencyLockEntry? entry = null;
            lockEntries?.TryGetValue(spec.Name, out entry);
            try
            {
                var (version, data) = ReadManifestDir(ResolveDependencyDir(configDir, spec));
                var installed = Sha256Integrity(data);
                if (entry is null)
                    results.Add(new DependencyCheckResult(
                        spec.Name, DependencyCheckStatus.Unresolved, null, null, version, installed,
                        "declared, and resolves, but is not in the lock yet"));
                else
                    results.Add(new DependencyCheckResult(
                        spec.Name,
                        installed == entry.Integrity ? DependencyCheckStatus.Current : DependencyCheckStatus.Drifted,
                        entry.Version, entry.Integrity, version, installed, null));
            }
            catch (UnresolvedException e)
            {
                results.Add(new DependencyCheckResult(
                    spec.Name, DependencyCheckStatus.Unresolved, entry?.Version, entry?.Integrity, null, null, e.Message));
            }
        }
        return results;
    }

    /// <summary>One report line per dependency (the same shape as the TypeScript <c>formatCheckLine</c>).</summary>
    public static string FormatCheckLine(DependencyCheckResult r)
    {
        var lockDesc = $"{r.LockVersion ?? "(none)"} ({(r.LockIntegrity is null ? "n/a" : Hash8(r.LockIntegrity))})";
        var installedDesc = $"{r.InstalledVersion ?? "(none)"} ({(r.InstalledIntegrity is null ? "n/a" : Hash8(r.InstalledIntegrity))})";
        return r.Status switch
        {
            DependencyCheckStatus.Current => $"{r.Name}: current — {lockDesc}",
            DependencyCheckStatus.Drifted =>
                $"{r.Name}: drifted — lock {lockDesc}, installed {installedDesc}; run meta deps sync and review the artifact diff",
            _ => $"{r.Name}: unresolved — {r.Detail ?? "could not resolve the dependency"}; run meta deps sync once the dependency is reachable",
        };
    }
}
