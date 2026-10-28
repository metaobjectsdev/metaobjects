// FR-023 — metadata dependencies, the CONSUME side: the `dependencies` key of
// `.metaobjects/config.json`, the lock (`deps.lock.json`) and the committed snapshot beside it.
//
// Mirrors server/typescript/packages/sdk/src/dependencies.ts and
// server/python/src/metaobjects/config/dependencies.py, in the same order: validate the lock,
// check each snapshot against it (offline), collide-check the exported nodes, then load the
// snapshots FIRST under `dep:<name>/<artifact>` source ids. The shared corpus
// fixtures/dependency-conformance/ pins the behaviour; this file adds no design of its own.
//
// The Node `meta deps sync` is the ONLY writer of the lock and the snapshot. This port reads and
// verifies them; it never writes either.
//
// A dependency's nodes are LOAD-ONLY by default: they load so the project's own model resolves
// against them, but the codegen selection point drops them unless the project's own
// `scope.include` NAMES their package (see ImportScope.InScope).
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.Config;

/// <summary>The cross-port file names and prefixes of a dependency set (DESIGN §3).</summary>
public static class DependencyFiles
{
    /// <summary>Directory under <c>.metaobjects/</c> holding the synced snapshots, one subdirectory per dependency.</summary>
    public const string DepsDir = "deps";

    /// <summary><c>meta deps sync</c>'s output.</summary>
    public const string LockFile = "deps.lock.json";

    /// <summary>The publisher-generated manifest beside a dependency's artifact.</summary>
    public const string ManifestFile = "metaobjects.pkg.json";

    /// <summary>Suffix of a dependency's canonical-JSON artifact, e.g. <c>acme-common.metaobjects.json</c>.</summary>
    public const string ArtifactSuffix = ".metaobjects.json";

    /// <summary>Prefix of a dependency artifact's source id: <c>dep:&lt;name&gt;/&lt;artifact&gt;</c>.</summary>
    public const string SourceIdPrefix = "dep:";

    /// <summary>Prefix of an <c>integrity</c> value: <c>sha256-</c> plus the lowercase hex sha256 of the artifact bytes.</summary>
    public const string IntegrityPrefix = "sha256-";
}

/// <summary>One validated entry of the config's <c>dependencies</c> array.</summary>
/// <param name="Name">The LOCAL alias the config, lock and <c>.metaobjects/deps/&lt;name&gt;/</c> key on.</param>
/// <param name="Transport">The one transport key: <c>path</c>, <c>npm</c> or <c>python</c>.</param>
/// <param name="Location">The transport key's value.</param>
/// <param name="Dir">The optional <c>dir</c>, legal only beside <c>npm</c> / <c>python</c>.</param>
public sealed record DependencySpec(string Name, string Transport, string Location, string? Dir);

/// <summary>One validated entry of the lock's <c>dependencies</c> object.</summary>
public sealed record DependencyLockEntry(
    string Version, string MetamodelVersion, string Artifact, string Integrity,
    IReadOnlyList<string> Packages, IReadOnlyList<string> Nodes);

/// <summary>A dependency that passed the lock check, ready for the loader.</summary>
public sealed record ResolvedDependency(
    string Name, string Version, IReadOnlyList<string> Packages, IReadOnlyList<string> Nodes,
    string ArtifactPath, string SourceId);

public static partial class DependencyResolver
{
    private static readonly Regex NameRe = NameRegex();
    private static readonly Regex MetamodelVersionRe = MetamodelVersionRegex();
    private static readonly Regex IntegrityRe = IntegrityRegex();

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]*$")]
    private static partial Regex NameRegex();

    [GeneratedRegex(@"^\d+\.\d+$")]
    private static partial Regex MetamodelVersionRegex();

    [GeneratedRegex("^sha256-[0-9a-f]{64}$")]
    private static partial Regex IntegrityRegex();

    private static readonly string[] TransportKeys = ["path", "npm", "python"];
    private static readonly string[] LockKeys = ["schema_version", "dependencies"];
    private static readonly string[] LockEntryKeys =
        ["version", "metamodelVersion", "artifact", "integrity", "packages", "nodes", "resolvedFrom"];

    private const string MetaObjectsDir = ".metaobjects";

    // ------------------------------------------------------------------
    // The config's `dependencies` array
    // ------------------------------------------------------------------

    /// <summary>
    /// Validate one entry of <c>dependencies</c>: a <c>name</c>, exactly one transport key, an
    /// optional <c>dir</c> legal only beside <c>npm</c> / <c>python</c>, and nothing else (a
    /// <c>mode</c> key included — it was removed). Mirrors the TypeScript <c>DependencySpecSchema</c>.
    /// </summary>
    internal static DependencySpec ReadSpec(JsonElement dep, string configPath)
    {
        MetaModelException Fail(string reason) => new(
            $"{configPath}: invalid \"dependencies\" entry ({reason})", ErrorCode.ERR_BAD_ATTR_VALUE);

        if (dep.ValueKind != JsonValueKind.Object) throw Fail("must be an object");

        if (!dep.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String ||
            !NameRe.IsMatch(nameEl.GetString()!))
            throw Fail("\"name\" must match ^[a-z0-9][a-z0-9._-]*$");
        var name = nameEl.GetString()!;

        var transports = TransportKeys.Where(k => dep.TryGetProperty(k, out _)).ToList();
        if (transports.Count != 1) throw Fail("exactly one of \"path\" / \"npm\" / \"python\" is required");
        var transport = transports[0];

        var location = dep.GetProperty(transport);
        if (location.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(location.GetString()))
            throw Fail($"\"{transport}\" must be a non-empty string");

        var allowed = new HashSet<string>(StringComparer.Ordinal) { "name", transport };
        if (transport is "npm" or "python") allowed.Add("dir");
        var extra = dep.EnumerateObject().Select(p => p.Name).Where(n => !allowed.Contains(n))
            .Order(StringComparer.Ordinal).ToList();
        if (extra.Count > 0) throw Fail($"unknown key(s): [{string.Join(", ", extra)}]");

        string? dir = null;
        if (dep.TryGetProperty("dir", out var dirEl))
        {
            if (dirEl.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(dirEl.GetString()))
                throw Fail("\"dir\" must be a non-empty string");
            dir = dirEl.GetString();
        }

        return new DependencySpec(name, transport, location.GetString()!, dir);
    }

    // ------------------------------------------------------------------
    // The lock
    // ------------------------------------------------------------------

    private static MetaModelException Stale(string message) =>
        new(message, ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);

    /// <summary>Every stale-snapshot refusal, in one place, so each ends with the command that fixes it.</summary>
    private static MetaModelException StaleSnapshot(string detail) => Stale($"{detail}; run `meta deps sync`");

    private static bool IsStrictlyAscending(IReadOnlyList<string> values)
    {
        for (var i = 0; i + 1 < values.Count; i++)
            if (string.CompareOrdinal(values[i], values[i + 1]) >= 0) return false;
        return true;
    }

    private static IReadOnlyList<string> SortedStrings(JsonElement obj, string field, string context)
    {
        if (!obj.TryGetProperty(field, out var el) || el.ValueKind != JsonValueKind.Array ||
            el.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String || v.GetString()!.Length == 0))
            throw Stale($"{context}: \"{field}\" must be an array of non-empty strings");
        var values = el.EnumerateArray().Select(v => v.GetString()!).ToList();
        if (!IsStrictlyAscending(values)) throw Stale($"{context}: \"{field}\" must be sorted");
        return values;
    }

    private static string RequiredString(JsonElement obj, string field, string context, string what)
    {
        if (!obj.TryGetProperty(field, out var el) || el.ValueKind != JsonValueKind.String ||
            string.IsNullOrEmpty(el.GetString()))
            throw Stale($"{context}: \"{field}\" must be {what}");
        return el.GetString()!;
    }

    private static void ValidateResolvedFrom(JsonElement entry, string context)
    {
        if (!entry.TryGetProperty("resolvedFrom", out var rf) || rf.ValueKind != JsonValueKind.Object)
            throw Stale($"{context}: \"resolvedFrom\" must be an object");

        var transports = TransportKeys.Where(k => rf.TryGetProperty(k, out _)).ToList();
        if (transports.Count != 1)
            throw Stale($"{context}: \"resolvedFrom\" must have exactly one of \"path\" / \"npm\" / \"python\"");
        var transport = transports[0];

        var value = rf.GetProperty(transport);
        if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
            throw Stale($"{context}: \"resolvedFrom.{transport}\" must be a non-empty string");

        var allowed = new HashSet<string>(StringComparer.Ordinal) { transport };
        if (transport is "npm" or "python") allowed.Add("dir");
        var extra = rf.EnumerateObject().Select(p => p.Name).Where(n => !allowed.Contains(n))
            .Order(StringComparer.Ordinal).ToList();
        if (extra.Count > 0) throw Stale($"{context}: \"resolvedFrom\" unknown key(s): [{string.Join(", ", extra)}]");

        if (rf.TryGetProperty("dir", out var dir) &&
            (dir.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(dir.GetString())))
            throw Stale($"{context}: \"resolvedFrom.dir\" must be a non-empty string");
    }

    /// <summary>
    /// Validate a parsed <c>deps.lock.json</c> (DESIGN §3.3). Any shape violation — unsorted keys, an
    /// entry with an unknown key (a resurrected <c>mode</c> included), two <c>resolvedFrom</c>
    /// transports, a malformed field — is <c>ERR_DEPENDENCY_SNAPSHOT_STALE</c>. Entries come back in
    /// dependency-NAME order.
    /// </summary>
    internal static IReadOnlyDictionary<string, DependencyLockEntry> ValidateLock(JsonElement root)
    {
        const string context = DependencyFiles.LockFile;
        if (root.ValueKind != JsonValueKind.Object) throw Stale($"{context}: must be an object");

        var extraTop = root.EnumerateObject().Select(p => p.Name).Where(n => !LockKeys.Contains(n))
            .Order(StringComparer.Ordinal).ToList();
        if (extraTop.Count > 0) throw Stale($"{context}: unknown key(s): [{string.Join(", ", extraTop)}]");

        if (!root.TryGetProperty("schema_version", out var sv) || sv.ValueKind != JsonValueKind.Number ||
            !sv.TryGetDouble(out var schemaVersion) || schemaVersion != 1)
            throw Stale($"{context}: \"schema_version\" must be 1");

        if (!root.TryGetProperty("dependencies", out var deps) || deps.ValueKind != JsonValueKind.Object)
            throw Stale($"{context}: \"dependencies\" must be an object");

        var names = deps.EnumerateObject().Select(p => p.Name).ToList();
        if (!IsStrictlyAscending(names)) throw Stale($"{context}: dependency keys must be sorted");

        var entries = new SortedDictionary<string, DependencyLockEntry>(StringComparer.Ordinal);
        foreach (var prop in deps.EnumerateObject())
        {
            var entry = prop.Value;
            var entryContext = $"{context} ({prop.Name})";
            if (entry.ValueKind != JsonValueKind.Object) throw Stale($"{entryContext}: must be an object");

            var extra = entry.EnumerateObject().Select(p => p.Name).Where(n => !LockEntryKeys.Contains(n))
                .Order(StringComparer.Ordinal).ToList();
            if (extra.Count > 0) throw Stale($"{entryContext}: unknown key(s): [{string.Join(", ", extra)}]");

            var version = RequiredString(entry, "version", entryContext, "a non-empty string");
            var metamodel = RequiredString(entry, "metamodelVersion", entryContext, "a string matching ^\\d+\\.\\d+$");
            if (!MetamodelVersionRe.IsMatch(metamodel))
                throw Stale($"{entryContext}: \"metamodelVersion\" must match ^\\d+\\.\\d+$");
            var artifact = RequiredString(entry, "artifact", entryContext, $"a string ending with '{DependencyFiles.ArtifactSuffix}'");
            if (!artifact.EndsWith(DependencyFiles.ArtifactSuffix, StringComparison.Ordinal))
                throw Stale($"{entryContext}: \"artifact\" must end with '{DependencyFiles.ArtifactSuffix}'");
            var integrity = RequiredString(entry, "integrity", entryContext, "a string matching ^sha256-[0-9a-f]{64}$");
            if (!IntegrityRe.IsMatch(integrity))
                throw Stale($"{entryContext}: \"integrity\" must match ^sha256-[0-9a-f]{{64}}$");
            var packages = SortedStrings(entry, "packages", entryContext);
            var nodes = SortedStrings(entry, "nodes", entryContext);
            ValidateResolvedFrom(entry, entryContext);

            entries[prop.Name] = new DependencyLockEntry(version, metamodel, artifact, integrity, packages, nodes);
        }
        return entries;
    }

    /// <summary>
    /// Read <c>&lt;configDir&gt;/.metaobjects/deps.lock.json</c>. Null when the file does not exist: a
    /// project declaring no dependencies has no lock, and that is not an error. A present but
    /// malformed file raises.
    /// </summary>
    public static IReadOnlyDictionary<string, DependencyLockEntry>? ReadLock(string configDir)
    {
        var path = Path.Combine(configDir, MetaObjectsDir, DependencyFiles.LockFile);
        if (!File.Exists(path)) return null;
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            throw Stale($"{path} exists but could not be read as JSON: {e.Message}");
        }
        using (doc) return ValidateLock(doc.RootElement);
    }

    /// <summary><c>sha256-</c> plus the lowercase hex sha256 of <paramref name="data"/>.</summary>
    public static string Sha256Integrity(byte[] data) =>
        DependencyFiles.IntegrityPrefix + Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    /// <summary><c>dep:&lt;name&gt;/&lt;artifact&gt;</c> — a dependency artifact's source id.</summary>
    public static string SourceId(string name, string artifact) =>
        $"{DependencyFiles.SourceIdPrefix}{name}/{artifact}";

    private static string MetamodelMajor(string version) => version.Split('.')[0];

    /// <summary>
    /// Verify a project's committed snapshot against its lock, and resolve the dependencies the load
    /// will take FIRST. Offline: nothing here touches a publisher. Two failures are NOT staleness and
    /// get their own codes: a dependency published against a different metamodel MAJOR
    /// (<c>ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE</c>, ADR-0035 Amendment 2) and two dependencies
    /// exporting one fully-qualified node (<c>ERR_DEPENDENCY_NODE_COLLISION</c>).
    /// <para>Result order is dependency NAME order, never the config's declaration order: the artifacts
    /// lead the load, so declaration order must not decide what the loader sees first. A project
    /// with no dependencies and no lock resolves to an empty list without touching the filesystem.</para>
    /// </summary>
    public static IReadOnlyList<ResolvedDependency> VerifySnapshot(
        string configDir, IReadOnlyList<DependencySpec> specs,
        IReadOnlyDictionary<string, DependencyLockEntry>? lockEntries)
    {
        var declared = specs.Select(s => s.Name).ToList();

        if (lockEntries is null)
        {
            if (declared.Count == 0) return [];
            throw StaleSnapshot(
                $"{declared.Count} dependenc{(declared.Count == 1 ? "y is" : "ies are")} declared " +
                $"({string.Join(", ", declared)}) but there is no {MetaObjectsDir}/{DependencyFiles.LockFile}");
        }

        var declaredNames = declared.ToHashSet(StringComparer.Ordinal);
        foreach (var name in lockEntries.Keys)
            if (!declaredNames.Contains(name))
                throw StaleSnapshot(
                    $"{MetaObjectsDir}/{DependencyFiles.LockFile} locks dependency \"{name}\", which " +
                    $"{MetaObjectsDir}/config.json no longer declares");

        var resolved = new List<ResolvedDependency>();
        foreach (var name in declaredNames.Order(StringComparer.Ordinal))
        {
            if (!lockEntries.TryGetValue(name, out var entry))
                throw StaleSnapshot(
                    $"dependency \"{name}\" is declared but {MetaObjectsDir}/{DependencyFiles.LockFile} has no entry for it");

            var artifactPath = Path.Combine(configDir, MetaObjectsDir, DependencyFiles.DepsDir, name, entry.Artifact);
            byte[] data;
            try
            {
                data = File.ReadAllBytes(artifactPath);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw StaleSnapshot($"the committed snapshot for \"{name}\" is missing (expected {artifactPath})");
            }

            var actual = Sha256Integrity(data);
            if (actual != entry.Integrity)
                throw StaleSnapshot(
                    $"the committed snapshot for \"{name}\" does not match the lock — {artifactPath} " +
                    $"hashes to {actual}, the lock records {entry.Integrity}");

            if (MetamodelMajor(entry.MetamodelVersion) != MetamodelMajor(RegistryManifest.MetamodelVersion))
                throw new MetaModelException(
                    $"dependency \"{name}\" was published against metamodel {entry.MetamodelVersion}; " +
                    $"this toolchain speaks {RegistryManifest.MetamodelVersion}. A different metamodel MAJOR is a " +
                    $"different metadata contract — upgrade the toolchain, or use a release of \"{name}\" " +
                    "built against it.",
                    ErrorCode.ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE);

            resolved.Add(new ResolvedDependency(
                name, entry.Version, entry.Packages, entry.Nodes, artifactPath, SourceId(name, entry.Artifact)));
        }

        // Collision is checked across the WHOLE resolved set, so the error names the two
        // dependencies in name order however the config declared them.
        var owner = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var dep in resolved)
            foreach (var node in dep.Nodes)
            {
                if (owner.TryGetValue(node, out var prior))
                    throw new MetaModelException(
                        $"dependencies \"{prior}\" and \"{dep.Name}\" both export \"{node}\" — one " +
                        "fully-qualified node cannot come from two places, and whichever loaded " +
                        "second would silently win",
                        ErrorCode.ERR_DEPENDENCY_NODE_COLLISION);
                owner[node] = dep.Name;
            }

        return resolved;
    }

    // ------------------------------------------------------------------
    // Package-keyed predicates
    // ------------------------------------------------------------------

    /// <summary>A fully-qualified name minus its trailing <c>::name</c>; <c>""</c> for a root-level name.</summary>
    public static string PackageOf(string key)
    {
        var i = key.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return i == -1 ? "" : key[..i];
    }

    /// <summary>
    /// Does some pattern in <paramref name="patterns"/> name <paramref name="pkg"/> LITERALLY (DESIGN §11.1
    /// item 2)? Drop the pattern's final segment, which names the node: what remains must be
    /// wildcard-free and equal <paramref name="pkg"/>. So <c>acme::common::**</c> and
    /// <c>acme::common::Address</c> both name <c>acme::common</c>; <c>acme::**</c> and <c>**</c> reach
    /// its nodes but name nothing, and an absent or empty list names nothing. NOT
    /// <see cref="Scope.MatchesScope"/>: a pattern that MATCHES a package's nodes is a weaker statement
    /// than one that NAMES the package.
    /// </summary>
    public static bool ExplicitlyIncludes(IReadOnlyList<string>? patterns, string pkg)
    {
        if (patterns is null || patterns.Count == 0 || pkg.Length == 0) return false;
        foreach (var pattern in patterns)
        {
            var named = PackageOf(pattern);
            if (named.Length > 0 && !named.Contains('*') && named == pkg) return true;
        }
        return false;
    }
}

/// <summary>
/// Everything the dependency-aware load resolved for one project: the dependencies whose snapshots
/// lead the load, and the predicates every action surface reads to decide whether an imported object
/// is excluded (DESIGN §11.1 item 2). Attached to the loaded <see cref="MetaRoot"/> as
/// <see cref="MetaRoot.ImportScope"/>, beside the project's naming and wire settings, so a generator
/// reads the same answer wherever it sits.
/// </summary>
public sealed class ImportScope
{
    /// <summary>A project that imports nothing: every predicate answers as if dependencies did not exist.</summary>
    public static ImportScope None { get; } = new([], [], null);

    /// <summary>The resolved dependencies, in dependency-NAME order.</summary>
    public IReadOnlyList<ResolvedDependency> Dependencies { get; }

    /// <summary>THE exclusion key (DESIGN §11.5): the union of every dependency's <c>packages</c>.</summary>
    public IReadOnlySet<string> ImportedPackages { get; }

    /// <summary>
    /// The union of every dependency's <c>nodes</c>, read only by <see cref="FindUnownedPackage"/> to tell
    /// an overlay of an imported node from a genuinely new local declaration. NOT the exclusion key.
    /// </summary>
    public IReadOnlySet<string> ImportedNodes { get; }

    /// <summary>The project's declared <c>scope.include</c>, for the explicit-include rule.</summary>
    public IReadOnlyList<string> ScopeInclude { get; }

    /// <summary>The project's declared <c>migrate.scope</c>, or null when it declares none.</summary>
    public IReadOnlyList<string>? MigrateScope { get; }

    private readonly CompiledScope? _migrate;

    /// <summary>True when at least one dependency is resolved.</summary>
    public bool HasImports => Dependencies.Count > 0;

    private ImportScope(IReadOnlyList<ResolvedDependency> dependencies, IReadOnlyList<string> scopeInclude, IReadOnlyList<string>? migrateScope)
    {
        Dependencies = dependencies;
        ImportedPackages = dependencies.SelectMany(d => d.Packages).ToHashSet(StringComparer.Ordinal);
        ImportedNodes = dependencies.SelectMany(d => d.Nodes).ToHashSet(StringComparer.Ordinal);
        ScopeInclude = scopeInclude;
        MigrateScope = migrateScope;
        // `migrate.scope` is compiled up front so a malformed pattern is a config error here, not a
        // surprise at the first predicate call. Undefined (no `migrate.scope`, no dependency) admits all.
        _migrate = migrateScope is null && dependencies.Count == 0 ? null : Scope.CompileScope(migrateScope);
    }

    /// <summary>
    /// Resolve the dependency set of the project whose <c>.metaobjects/</c> directory sits in
    /// <paramref name="configDir"/>: read the lock, check every snapshot against it, and gather the
    /// predicates' inputs from <paramref name="config"/>. Throws <see cref="MetaModelException"/> with
    /// the <c>ERR_DEPENDENCY_*</c> code when the snapshot cannot be trusted.
    /// </summary>
    public static ImportScope Resolve(string configDir, NeutralConfig? config)
    {
        var specs = config?.Dependencies ?? [];
        var scopeInclude = config?.ScopeInclude ?? [];
        var migrateScope = config?.MigrateScope;

        var lockEntries = DependencyResolver.ReadLock(configDir);
        var resolved = specs.Count == 0 && lockEntries is null
            ? []
            : DependencyResolver.VerifySnapshot(configDir, specs, lockEntries);
        return new ImportScope(resolved, scopeInclude, migrateScope);
    }

    /// <summary>Is <paramref name="fqn"/> in a package one of this project's dependencies owns?</summary>
    public bool Imported(string fqn) => ImportedPackages.Contains(DependencyResolver.PackageOf(fqn));

    /// <summary>
    /// The output filter for codegen: an object this project imports is not its own to generate, unless
    /// its package is NAMED by <c>scope.include</c>. <c>!Imported(fqn) || ExplicitlyIncludes(scope.include, packageOf(fqn))</c>.
    /// <para>Python's shape, not TypeScript's: no <c>matchesScope</c> conjunct on the project's OWN objects,
    /// because neither this port nor Python has ever scoped its own generated output. Only the
    /// import-exclusion half is new behaviour here; <c>scope.include</c> narrows nothing of the
    /// project's own, and only ever widens which imported package is let back in.</para>
    /// </summary>
    public bool InScope(string fqn)
    {
        var pkg = DependencyResolver.PackageOf(fqn);
        return !ImportedPackages.Contains(pkg) || DependencyResolver.ExplicitlyIncludes(ScopeInclude, pkg);
    }

    /// <summary>
    /// The schema-side twin of <see cref="InScope"/>: <c>matchesScope(fqn, migrate.scope)</c> and the
    /// same import rule against <c>migrate.scope</c>. True for everything when nothing is declared and
    /// nothing is imported. Nothing in this port consumes it (schema is TypeScript-owned, ADR-0015); it
    /// is here so the corpus's <c>expectMigrateGoverned</c> arm passes with no exemption.
    /// </summary>
    public bool InMigrateScope(string fqn)
    {
        if (_migrate is null) return true;
        if (!Scope.MatchesScope(fqn, _migrate)) return false;
        var pkg = DependencyResolver.PackageOf(fqn);
        return !ImportedPackages.Contains(pkg) || DependencyResolver.ExplicitlyIncludes(MigrateScope, pkg);
    }

    /// <summary>The name of the dependency that owns <paramref name="pkg"/>, or null when none does.</summary>
    public string? ImportedFrom(string pkg) =>
        Dependencies.FirstOrDefault(d => d.Packages.Contains(pkg, StringComparer.Ordinal))?.Name;

    /// <summary>
    /// The snapshot artifacts as loader sources, in dependency-NAME order, each under its
    /// <c>dep:&lt;name&gt;/&lt;artifact&gt;</c> id so a load error names the dependency rather than a local file.
    /// </summary>
    public IReadOnlyList<IMetaDataSource> Sources() =>
        Dependencies.Select(d => (IMetaDataSource)new FileSource(d.ArtifactPath, d.SourceId)).ToList();

    /// <summary>
    /// FR-023 §11.5 — a consumer may not declare a NEW top-level node into a package one of its
    /// dependencies owns. Imported-ness is decided by PACKAGE, so such a node would be excluded from
    /// this project's own codegen with no output and no error; this is what keeps that rule from
    /// failing silently. An overlay of the dependency's own node is untouched: its resolution key is in
    /// <see cref="ImportedNodes"/>. Returns the refusal, or null. Call it AFTER the loader's own errors,
    /// never before: an unflagged overlay whose target the upstream removed fails first, with its own code.
    /// </summary>
    public MetaError? FindUnownedPackage(MetaRoot root)
    {
        if (ImportedPackages.Count == 0) return null;

        // ADR-0039 SANCTIONED own-accessor case: a root-level scan. `MetaRoot` has no super, so own and
        // effective children are the same set here, and the question asked is precisely "what did this
        // tree declare at the top level", which is the own layer by definition.
        foreach (var node in root.Objects())
        {
            var key = node.ResolutionKey();
            var pkg = DependencyResolver.PackageOf(key);
            if (!ImportedPackages.Contains(pkg) || ImportedNodes.Contains(key)) continue;
            return new MetaError(
                $"\"{key}\" is declared here, but the package \"{pkg}\" belongs to a metadata dependency this " +
                $"project imports, and \"{key}\" is not one of the nodes that dependency exports. Declare it in " +
                "a package this project owns and 'extends' the dependency's node if it needs its shape; if it " +
                "was meant to AMEND the dependency's node, give it that node's name and 'overlay: true'; if this " +
                $"project really does own \"{pkg}\", name it in 'scope.include' and stop importing it.",
                ErrorCode.ERR_DEPENDENCY_PACKAGE_NOT_OWNED);
        }
        return null;
    }
}
