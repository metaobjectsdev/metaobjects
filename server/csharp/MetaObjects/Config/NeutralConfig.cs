// Port-neutral `.metaobjects/config.json` reading.
//
// Reads the NEUTRAL SUBSET (`schema_version`, `sources`, `libraries`, `dependencies`, and the two
// pattern lists FR-023 needs: `scope.include` and `migrate.scope`). The file also carries
// TypeScript-owned keys (`pending_in_git`, `confidence_thresholds`, `extract`, and the rest of
// `migrate` and `scope`); those are IGNORED rather than modeled, so a new TS-only key never becomes
// a four-port change. See
// docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md §4.
//
// `dependencies` (FR-023) is read at EVERY rung of the source ladder, including the explicit
// metadata directory a C# command is handed, because this port has no native config surface of its
// own: `.metaobjects/config.json` is where a dependency is declared. `scope.include` is read only
// for the explicit-include rule (a dependency's package is generated and migrated only when the
// project NAMES it); `scope.exclude` is not read, because this port has never scoped its own output.
//
// `libraries` (FR-043) is read here — not just by TypeScript — because this port has
// no rung-2 native config surface (unlike Java/Kotlin's pom or Python's
// metaobjects.config.yaml): `.metaobjects/config.json` is the ONLY place a C# adopter
// can opt into a shipped library at all. See docs/superpowers/specs/2026-09-13-fr-043-
// feature-and-nfr-packages-design.md §12 Q4 ("should libraries move to
// .metaobjects/config.json? yes, outright... the JVM/C# ports can follow").
//
// `naming` (ADR-0058) is read here too — the one project setting for how a metadata name
// becomes a physical database name, read by every port. An unknown key, an unknown value,
// or a non-object `naming` is refused (ERR_BAD_ATTR_VALUE), the same "present but
// wrong-shaped raises" rule `sources`/`libraries` already follow.
//
// `csharp.outDir` is the C#-scoped generated-code directory and `csharp.namespace` the C# namespace
// generated code lands in; the other ports ignore the block.
//
// `wire` (ADR-0019 Amendment 2) is read here too — the output form of a generated REST surface
// (`decimals`, `nullMembers`, `durations`), refused exactly as `naming` is.
using System.Text.Json;
using MetaObjects.Meta;

namespace MetaObjects.Config;

public sealed class NeutralConfig
{
    /// The DEFAULT value of `sources` when the key is absent or empty — never a
    /// requirement, and never assumed to exist by any other code path.
    public const string DefaultMetadataDir = "metaobjects";

    private const string MetaObjectsDir = ".metaobjects";
    private const string ConfigFile = "config.json";
    private const int SupportedSchemaVersion = 1;

    /// Each entry is a raw source spec (e.g. `{"path": "model"}`,
    /// `{"resource": "com/acme/model"}`) — kind interpretation belongs to
    /// SourceResolver, not here.
    public IReadOnlyList<IReadOnlyDictionary<string, string>> Sources { get; }

    /// FR-043 selection tokens (e.g. `["iam", "iam/db"]`) — empty when the key is
    /// absent or an empty array. Validated against
    /// <see cref="MetaObjects.Library.LibrarySources.KnownTokens"/> at read time: an
    /// unrecognised token is a config MISTAKE (a human typed it), not the
    /// programmatic-caller case <c>LibrarySources.Resolve</c> tolerates by skipping —
    /// skipped here, it would resurface as ERR_UNRESOLVED_SUPER against the adopter's
    /// own metadata, the wrong place to send someone looking. Mirrors TypeScript's
    /// `resolveCollection` (ERR_UNKNOWN_LIBRARY).
    public IReadOnlyList<string> Libraries { get; }

    /// <summary>
    /// FR-023 — the declared metadata dependencies, each already validated; empty when the key is absent.
    /// Names are unique. Resolving them to a committed snapshot is <see cref="ImportScope.Resolve"/>'s job.
    /// </summary>
    public IReadOnlyList<DependencySpec> Dependencies { get; }

    /// <summary>FR-023 — <c>scope.include</c>, read only for the explicit-include rule. Empty when absent.</summary>
    public IReadOnlyList<string> ScopeInclude { get; }

    /// <summary>FR-023 — <c>migrate.scope</c>, or null when the project declares none.</summary>
    public IReadOnlyList<string>? MigrateScope { get; }

    /// <summary>`migrate.dialect`: the SQL dialect the project's schema is built for, or null.</summary>
    public string? MigrateDialect { get; private init; }

    /// `csharp.outputLayout`: <c>"flat"</c> (the default, and what an absent key reads as) or
    /// <c>"package"</c>, where each per-object generator writes under the object's metadata package.
    public string OutputLayout { get; private init; } = "flat";

    /// `csharp.packageNamespaces`: <c>true</c> binds each packaged type to its metadata package's
    /// namespace even when `csharp.namespace` is set; an object maps packages to namespaces
    /// explicitly. Absent or <c>false</c> keeps the earlier rule (a configured namespace turns the
    /// per-package derivation off).
    public PackageNamespaceSetting PackageNamespaces { get; private init; } = PackageNamespaceSetting.Off;

    /// <summary><c>migrate.checks.skipRedundant</c>: leave out the CHECKs a column's own type already enforces.</summary>
    public bool MigrateSkipRedundantChecks { get; private init; }

    /// <summary>`migrate.foreignKeyIndexes`: index every foreign key the schema conventions leave
    /// without one, as `meta migrate` does. False when absent or not a boolean.</summary>
    public bool MigrateForeignKeyIndexes { get; private init; }

    /// <summary>`migrate.conventions`: the schema-conventions preset `meta migrate` builds with
    /// (`default`, `efcore`), or null when absent.</summary>
    public string? MigrateConventions { get; private init; }

    /// <summary>
    /// FR-023 — <c>requirements.inherit</c>: the dependencies whose requirements this project takes on
    /// as its own ledger (<see cref="ImportScope.InLedger"/>). Empty when absent.
    /// </summary>
    public IReadOnlyList<string> RequirementsInherit { get; private init; } = [];

    /// <summary>
    /// The directory holding the <c>.metaobjects/</c> folder this config was read from — where the lock and
    /// the committed dependency snapshots live beside it.
    /// </summary>
    public string ConfigDir { get; }

    /// ADR-0058 — the project's physical-naming rules (`naming` in config.json), each
    /// absent rule at its default. Never null: an absent `naming` key is the default,
    /// same as an empty `naming: {}` block.
    public PhysicalNaming Naming { get; }

    /// ADR-0019 Amendment 2 — the project's wire-format setting (`wire` in config.json), each
    /// absent key at its native default. Never null.
    public WireFormat Wire { get; }

    /// The project's `api` block (`api.pagination`, `api.unknownFields`). Never null: absent is the default.
    public ApiSettings Api { get; private init; } = ApiSettings.Default;

    /// The project's enum storage defaults (`enums` in config.json). Never null: an absent
    /// block is no default, same as an empty `enums: {}`.
    public EnumDefaults Enums { get; private init; } = EnumDefaults.Default;

    /// The C# port's generated-code directory (`csharp.outDir` in config.json), resolved
    /// against the directory holding `.metaobjects/` so it reads the same from any working
    /// directory. Null when the key is absent. `--out` on the command line wins over it.
    public string? OutDir { get; }

    /// The C# namespace generated code lands in (`csharp.namespace` in config.json), or null when
    /// the key is absent. `--namespace` on the command line wins over it. It is the namespace for
    /// generated types no package binding places (GenConfig.Namespace); with neither, a run that
    /// emits such a type stops and asks for one.
    public string? Namespace { get; }

    /// `csharp.providers` — the project's own metamodel providers (assembly path resolved against
    /// the directory holding `.metaobjects/`, plus a type name). Empty when absent. Instantiated by
    /// <see cref="ProviderLoader"/>, not here, so reading a config never loads code.
    public IReadOnlyList<ProviderSpec> Providers { get; }

    private NeutralConfig(
        IReadOnlyList<IReadOnlyDictionary<string, string>> sources, IReadOnlyList<string> libraries,
        PhysicalNaming naming, WireFormat wire, (string? OutDir, string? Namespace, IReadOnlyList<ProviderSpec> Providers) csharp,
        IReadOnlyList<DependencySpec> dependencies, IReadOnlyList<string> scopeInclude,
        IReadOnlyList<string>? migrateScope, string configDir)
    {
        Dependencies = dependencies;
        ScopeInclude = scopeInclude;
        MigrateScope = migrateScope;
        ConfigDir = configDir;
        OutDir = csharp.OutDir;
        Namespace = csharp.Namespace;
        Providers = csharp.Providers;
        Sources = sources;
        Libraries = libraries;
        Naming = naming;
        Wire = wire;
    }

    /// Returns null when `<configDir>/.metaobjects/config.json` does not exist.
    /// A file that EXISTS but is malformed THROWS — swallowing it would make a
    /// typo'd config behave identically to no config at all, silently loading
    /// from a possibly-stale default directory instead. The exact error code
    /// used here is deliberately NOT part of the cross-port contract (only the
    /// raise-don't-degrade behavior is), so callers should match on message,
    /// not code, for this path.
    public static NeutralConfig? Read(string configDir) => Read(configDir, validateNaming: true);

    /// `migrate.checks.skipRedundant`, as the TypeScript `meta migrate` reads it; false when absent or not a boolean.
    private static bool ReadMigrateSkipRedundant(JsonElement root) =>
        root.TryGetProperty("migrate", out var migrate) && migrate.ValueKind == JsonValueKind.Object
        && migrate.TryGetProperty("checks", out var checks) && checks.ValueKind == JsonValueKind.Object
        && checks.TryGetProperty("skipRedundant", out var skip) && skip.ValueKind == JsonValueKind.True;

    /// `migrate.dialect`, as the TypeScript `meta migrate` reads it; null when absent or not a string.
    private static string? ReadMigrateDialect(JsonElement root) => ReadMigrateString(root, "dialect");

    /// One string in the TypeScript-owned `migrate` block; null when absent or not a string.
    private static string? ReadMigrateString(JsonElement root, string key) =>
        root.TryGetProperty("migrate", out var migrate) && migrate.ValueKind == JsonValueKind.Object
        && migrate.TryGetProperty(key, out var d) && d.ValueKind == JsonValueKind.String
            ? d.GetString()
            : null;

    /// `migrate.foreignKeyIndexes`; false when absent or not a boolean (the TypeScript reader
    /// refuses a non-boolean, and `meta migrate` is where the file is validated).
    private static bool ReadMigrateForeignKeyIndexes(JsonElement root) =>
        root.TryGetProperty("migrate", out var migrate) && migrate.ValueKind == JsonValueKind.Object
        && migrate.TryGetProperty("foreignKeyIndexes", out var v) && v.ValueKind == JsonValueKind.True;

    /// <summary>
    /// As <see cref="Read(string)"/>; with <paramref name="validateNaming"/> false a
    /// <c>naming</c> value no strategy registered in THIS process answers is kept by name
    /// (<see cref="ColumnNamingStrategy.ByName"/>) instead of refused, and refused when it is
    /// applied. For a caller that hands the config to another process that registers it — stock
    /// <c>dotnet meta verify</c> handing <c>--codegen</c> to the project's codegen runner. A wrong
    /// SHAPE is still refused.
    /// </summary>
    public static NeutralConfig? Read(string configDir, bool validateNaming)
    {
        var path = Path.Combine(configDir, MetaObjectsDir, ConfigFile);
        if (!File.Exists(path)) return null;

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            throw new MetaModelException(
                $"{path} exists but could not be read as JSON: {e.Message}",
                ErrorCode.ERR_MALFORMED_JSON);
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new MetaModelException($"{path} must contain a JSON object", ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);

            if (!root.TryGetProperty("schema_version", out var v) ||
                v.ValueKind != JsonValueKind.Number ||
                // Compare as a double, not GetInt32(): a float-looking literal like
                // `1.0` is valid JSON and the other three ports all accept it as
                // equal to 1 — GetInt32() used to throw a raw, uncoded
                // FormatException on it instead. TryGetDouble never throws and a
                // genuinely non-integral value (e.g. `1.5`) still correctly fails
                // the equality check below.
                !v.TryGetDouble(out var schemaVersion) ||
                schemaVersion != SupportedSchemaVersion)
            {
                throw new MetaModelException(
                    $"{path}: unsupported schema_version (expected {SupportedSchemaVersion})",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            }

            var specs = new List<IReadOnlyDictionary<string, string>>();
            if (root.TryGetProperty("sources", out var srcs))
            {
                // A present `sources` key that is not an array must RAISE, not
                // silently read as "absent" — the latter would fall back to the
                // default directory with no diagnostic, exactly the "typo'd config
                // behaves like no config" failure this class exists to prevent (see
                // the file header). This is the GENERAL rule: a present-but-JSON-
                // null `sources` is just as wrong-typed as a present-but-object
                // `sources` — it is not a special case.
                if (srcs.ValueKind != JsonValueKind.Array)
                    throw new MetaModelException($"{path}: \"sources\" must be an array", ErrorCode.ERR_BAD_ATTR_VALUE);

                foreach (var s in srcs.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object)
                        throw new MetaModelException($"{path}: each \"sources\" entry must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

                    var d = new Dictionary<string, string>();
                    foreach (var p in s.EnumerateObject())
                    {
                        // Every source-spec value (`path`/`resource`/`package`) is a
                        // string — silently stringifying a non-string (the prior
                        // behavior) would let {"path": 123} load a directory
                        // literally named "123" rather than failing loudly on the
                        // typo'd config.
                        if (p.Value.ValueKind != JsonValueKind.String)
                            throw new MetaModelException($"{path}: \"sources\" entry \"{p.Name}\" must be a string", ErrorCode.ERR_BAD_ATTR_VALUE);
                        var value = p.Value.GetString()!;
                        if (string.IsNullOrWhiteSpace(value))
                            throw new MetaModelException($"{path}: \"sources\" entry \"{p.Name}\" must not be empty", ErrorCode.ERR_BAD_ATTR_VALUE);
                        d[p.Name] = value;
                    }

                    if (d.Count != 1)
                        throw new MetaModelException($"{path}: each \"sources\" entry must have exactly one key", ErrorCode.ERR_BAD_ATTR_VALUE);

                    specs.Add(d);
                }
            }

            var libraries = new List<string>();
            if (root.TryGetProperty("libraries", out var libs))
            {
                // Same "present-but-wrong-shaped raises" rule as `sources` above.
                if (libs.ValueKind != JsonValueKind.Array)
                    throw new MetaModelException($"{path}: \"libraries\" must be an array", ErrorCode.ERR_BAD_ATTR_VALUE);

                foreach (var l in libs.EnumerateArray())
                {
                    if (l.ValueKind != JsonValueKind.String)
                        throw new MetaModelException($"{path}: each \"libraries\" entry must be a string", ErrorCode.ERR_BAD_ATTR_VALUE);
                    var token = l.GetString()!;
                    if (string.IsNullOrWhiteSpace(token))
                        throw new MetaModelException($"{path}: each \"libraries\" entry must not be empty", ErrorCode.ERR_BAD_ATTR_VALUE);
                    libraries.Add(token);
                }

                var available = MetaObjects.Library.LibrarySources.KnownTokens();
                var unknown = libraries.Where(t => !available.Contains(t)).ToList();
                if (unknown.Count > 0)
                {
                    throw new MetaModelException(
                        $"{path}: \"libraries\" names unknown librar{(unknown.Count == 1 ? "y" : "ies")} " +
                        $"[{string.Join(", ", unknown)}]; available: [{string.Join(", ", available)}]",
                        ErrorCode.ERR_UNKNOWN_LIBRARY);
                }
            }

            var dependencies = ReadDependencies(root, path);
            var scopeInclude = ReadPatterns(root, path, "scope", "include") ?? [];
            var migrateScope = ReadPatterns(root, path, "migrate", "scope");

            var columns = ColumnNamingStrategy.SnakeCase;
            var tables = TableNamingRule.SnakeCase;
            string? collections = null;
            if (root.TryGetProperty("naming", out var naming))
            {
                // Present but not an object — the same "wrong-shaped raises" rule as
                // `sources`/`libraries` above.
                if (naming.ValueKind != JsonValueKind.Object)
                    throw new MetaModelException($"{path}: \"naming\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

                foreach (var p in naming.EnumerateObject())
                {
                    switch (p.Name)
                    {
                        // ADR-0058 Amendment 1: a value is the NAME of a registered strategy, a
                        // built-in or one the application registered (NamingStrategies) before
                        // this read. A name nothing answers is refused here, naming it.
                        case "columns":
                            if (p.Value.ValueKind != JsonValueKind.String)
                                throw new MetaModelException(
                                    $"{path}: \"naming.columns\" must be a string naming a column-naming strategy",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            if (!NamingStrategies.TryGetColumn(p.Value.GetString()!, out var column))
                            {
                                if (validateNaming)
                                    throw new MetaModelException(
                                        $"{path}: {NamingStrategies.UnknownMessage("columns", p.Value.GetString()!)}",
                                        ErrorCode.ERR_BAD_ATTR_VALUE);
                                column = ColumnNamingStrategy.ByName(p.Value.GetString()!);
                            }
                            columns = column;
                            break;
                        case "tables":
                            if (p.Value.ValueKind != JsonValueKind.String)
                                throw new MetaModelException(
                                    $"{path}: \"naming.tables\" must be a string naming a table-naming strategy",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            if (!NamingStrategies.TryGetTable(p.Value.GetString()!, out var table))
                            {
                                if (validateNaming)
                                    throw new MetaModelException(
                                        $"{path}: {NamingStrategies.UnknownMessage("tables", p.Value.GetString()!)}",
                                        ErrorCode.ERR_BAD_ATTR_VALUE);
                                table = TableNamingRule.ByName(p.Value.GetString()!);
                            }
                            tables = table;
                            break;
                        // The pluralizer an object without @collectionName takes its collection
                        // name from; refused here when nothing answers it.
                        case "collections":
                            if (p.Value.ValueKind != JsonValueKind.String)
                                throw new MetaModelException(
                                    $"{path}: \"naming.collections\" must be a string naming a pluralizer",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            collections = p.Value.GetString()!;
                            if (validateNaming && !NamingStrategies.TryGetPluralizer(collections, out _))
                                throw new MetaModelException(
                                    $"{path}: {NamingStrategies.UnknownMessage("collections", collections)}",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            break;
                        default:
                            throw new MetaModelException(
                                $"{path}: \"naming\" has an unknown key \"{p.Name}\" (expected \"columns\", \"tables\" and/or \"collections\")",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                }
            }

            // Unknown top-level keys, and every key of `scope` / `migrate` but the two pattern
            // lists read above, are IGNORED by design — see the file header.
            return new NeutralConfig(specs, libraries, new PhysicalNaming(columns, tables) { Collections = collections }, ReadWire(root, path),
                ReadCSharp(root, path, configDir), dependencies, scopeInclude, migrateScope,
                Path.GetFullPath(configDir))
            {
                Enums = ReadEnums(root, path),
                Api = ReadApi(root, path),
                RequirementsInherit = ReadRequirementsInherit(root, path),
                OutputLayout = ReadOutputLayout(root, path),
                PackageNamespaces = ReadPackageNamespaces(root, path),
                MigrateDialect = ReadMigrateDialect(root),
                MigrateSkipRedundantChecks = ReadMigrateSkipRedundant(root),
                MigrateForeignKeyIndexes = ReadMigrateForeignKeyIndexes(root),
                MigrateConventions = ReadMigrateString(root, "conventions"),
            };
        }
    }

    /// The `dependencies` array (FR-023): present-but-wrong-shaped raises, as `sources` and `libraries`
    /// do, and names must be unique because the name is the key of the lock and of the snapshot directory.
    private static IReadOnlyList<DependencySpec> ReadDependencies(JsonElement root, string path)
    {
        if (!root.TryGetProperty("dependencies", out var deps)) return [];
        if (deps.ValueKind != JsonValueKind.Array)
            throw new MetaModelException($"{path}: \"dependencies\" must be an array", ErrorCode.ERR_BAD_ATTR_VALUE);

        var specs = deps.EnumerateArray().Select(d => DependencyResolver.ReadSpec(d, path)).ToList();
        if (specs.Select(s => s.Name).Distinct(StringComparer.Ordinal).Count() != specs.Count)
            throw new MetaModelException($"{path}: \"dependencies\" names must be unique", ErrorCode.ERR_BAD_ATTR_VALUE);
        return specs;
    }

    /// FR-023 — <c>requirements.inherit</c>. Refused like <c>naming</c>: an unknown key inside
    /// <c>requirements</c> would otherwise be a misspelt <c>inherit</c> that silently leaves the ledger out.
    private static IReadOnlyList<string> ReadRequirementsInherit(JsonElement root, string path)
    {
        if (!root.TryGetProperty("requirements", out var block) || block.ValueKind == JsonValueKind.Null) return [];
        if (block.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"requirements\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        foreach (var p in block.EnumerateObject())
        {
            if (p.Name != "inherit")
                throw new MetaModelException(
                    $"{path}: \"requirements\" has an unknown key \"{p.Name}\" (expected \"inherit\")",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        return ReadPatterns(root, path, "requirements", "inherit") ?? [];
    }

    /// One pattern list nested in a TypeScript-owned block: `scope.include` or `migrate.scope`. The
    /// block must be an object when present and the list an array of non-empty strings; every OTHER key
    /// of the block is TypeScript's and is not read. Null when the block or the list is absent.
    private static IReadOnlyList<string>? ReadPatterns(JsonElement root, string path, string block, string key)
    {
        if (!root.TryGetProperty(block, out var b) || b.ValueKind == JsonValueKind.Null) return null;
        if (b.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"{block}\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        if (!b.TryGetProperty(key, out var list) || list.ValueKind == JsonValueKind.Null) return null;

        if (list.ValueKind != JsonValueKind.Array ||
            list.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(v.GetString())))
            throw new MetaModelException(
                $"{path}: \"{block}.{key}\" must be an array of non-empty strings", ErrorCode.ERR_BAD_ATTR_VALUE);
        return list.EnumerateArray().Select(v => v.GetString()!).ToList();
    }

    private static string ReadOutputLayout(JsonElement root, string path)
    {
        if (!root.TryGetProperty("csharp", out var block) || block.ValueKind != JsonValueKind.Object
            || !block.TryGetProperty("outputLayout", out var v)) return "flat";
        if (v.ValueKind != JsonValueKind.String || v.GetString() is not ("flat" or "package"))
            throw new MetaModelException(
                $"{path}: \"csharp.outputLayout\" must be \"flat\" or \"package\"", ErrorCode.ERR_BAD_ATTR_VALUE);
        return v.GetString()!;
    }

    private static PackageNamespaceSetting ReadPackageNamespaces(JsonElement root, string path)
    {
        if (!root.TryGetProperty("csharp", out var block) || block.ValueKind != JsonValueKind.Object
            || !block.TryGetProperty("packageNamespaces", out var v)) return PackageNamespaceSetting.Off;
        switch (v.ValueKind)
        {
            case JsonValueKind.True: return new PackageNamespaceSetting(true, null);
            case JsonValueKind.False: return PackageNamespaceSetting.Off;
            case JsonValueKind.Object:
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var e in v.EnumerateObject())
                {
                    if (e.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.Value.GetString()))
                        throw new MetaModelException(
                            $"{path}: \"csharp.packageNamespaces.{e.Name}\" must be a non-empty namespace string", ErrorCode.ERR_BAD_ATTR_VALUE);
                    map[e.Name] = e.Value.GetString()!;
                }
                return new PackageNamespaceSetting(false, map);
            default:
                throw new MetaModelException(
                    $"{path}: \"csharp.packageNamespaces\" must be true, false or an object mapping packages to namespaces",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
    }

    /// The `csharp` block: the C#-scoped settings `outDir`, where `dotnet meta gen` writes and
    /// `dotnet meta verify` diffs, and `namespace`, the namespace both generate under. The other
    /// ports ignore the block, as they ignore any key they do not own. An unknown key, a
    /// non-string or empty value, or a non-object block is refused, the same rule as `naming`.
    private static (string? OutDir, string? Namespace, IReadOnlyList<ProviderSpec> Providers) ReadCSharp(
        JsonElement root, string path, string configDir)
    {
        if (!root.TryGetProperty("csharp", out var block)) return (null, null, []);
        if (block.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"csharp\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

        string? outDir = null, ns = null;
        IReadOnlyList<ProviderSpec> providers = [];
        foreach (var p in block.EnumerateObject())
        {
            if (p.Name is "outputLayout" or "packageNamespaces") continue; // read by their own readers
            if (p.Name is not ("outDir" or "namespace" or "providers"))
                throw new MetaModelException(
                    $"{path}: \"csharp\" has an unknown key \"{p.Name}\" (expected \"outDir\", \"namespace\", \"providers\", \"outputLayout\" and/or \"packageNamespaces\")",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            if (p.Name == "providers")
            {
                providers = ReadProviders(p.Value, path, configDir);
                continue;
            }
            if (p.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(p.Value.GetString()))
                throw new MetaModelException(
                    $"{path}: \"csharp.{p.Name}\" must be a non-empty string", ErrorCode.ERR_BAD_ATTR_VALUE);
            if (p.Name == "outDir")
                outDir = Path.GetFullPath(p.Value.GetString()!, Path.GetFullPath(configDir));
            else
                ns = p.Value.GetString()!;
        }
        return (outDir, ns, providers);
    }

    /// `csharp.providers`: an array of `{ "assembly", "type" }` objects. Both keys are required
    /// non-empty strings; any other key is refused, like the rest of the `csharp` block.
    private static IReadOnlyList<ProviderSpec> ReadProviders(JsonElement value, string path, string configDir)
    {
        if (value.ValueKind != JsonValueKind.Array)
            throw new MetaModelException(
                $"{path}: \"csharp.providers\" must be an array of {{ \"assembly\", \"type\" }} objects", ErrorCode.ERR_BAD_ATTR_VALUE);
        var specs = new List<ProviderSpec>();
        var i = 0;
        foreach (var entry in value.EnumerateArray())
        {
            var at = $"csharp.providers[{i++}]";
            if (entry.ValueKind != JsonValueKind.Object)
                throw new MetaModelException($"{path}: \"{at}\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
            string? asm = null, type = null;
            foreach (var f in entry.EnumerateObject())
            {
                if (f.Name is not ("assembly" or "type"))
                    throw new MetaModelException(
                        $"{path}: \"{at}\" has an unknown key \"{f.Name}\" (expected \"assembly\" and \"type\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
                if (f.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(f.Value.GetString()))
                    throw new MetaModelException(
                        $"{path}: \"{at}.{f.Name}\" must be a non-empty string", ErrorCode.ERR_BAD_ATTR_VALUE);
                if (f.Name == "assembly") asm = f.Value.GetString()!; else type = f.Value.GetString()!;
            }
            if (asm is null || type is null)
                throw new MetaModelException(
                    $"{path}: \"{at}\" needs both \"assembly\" and \"type\"", ErrorCode.ERR_BAD_ATTR_VALUE);
            specs.Add(new ProviderSpec(Path.GetFullPath(asm, Path.GetFullPath(configDir)), type, path));
        }
        return specs;
    }

    /// The `enums` block: `maxLength`, a positive integer, is the column length of a string-stored
    /// enum with no @maxLength. An unknown key, a wrong-typed value, or a non-object block is
    /// refused, the same rule as `naming`.
    private static EnumDefaults ReadEnums(JsonElement root, string path)
    {
        if (!root.TryGetProperty("enums", out var enums)) return EnumDefaults.Default;
        if (enums.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"enums\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        long? maxLength = null;
        foreach (var p in enums.EnumerateObject())
        {
            switch (p.Name)
            {
                case "maxLength":
                    // A whole number however JSON spells it (32, 32.0, 1e2): a reader that parses
                    // numbers as doubles (TypeScript's) cannot tell those apart.
                    if (p.Value.ValueKind != JsonValueKind.Number || !p.Value.TryGetDouble(out var d)
                        || d <= 0 || d != Math.Floor(d) || d > long.MaxValue)
                        throw new MetaModelException(
                            $"{path}: \"enums.maxLength\" must be a positive integer",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                    maxLength = (long)d;
                    break;
                default:
                    throw new MetaModelException(
                        $"{path}: \"enums\" has an unknown key \"{p.Name}\" (expected \"maxLength\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return maxLength is null ? EnumDefaults.Default : new EnumDefaults(maxLength);
    }

    /// The `wire` block (ADR-0019 Amendment 2): an unknown key, an unknown value, or a
    /// non-object block is refused, the same rule as `naming`.
    private static WireFormat ReadWire(JsonElement root, string path)
    {
        if (!root.TryGetProperty("wire", out var wire)) return WireFormat.Default;
        if (wire.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"wire\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

        var decimals = DecimalWireForm.Native;
        var nullMembers = NullMemberForm.Native;
        var durations = DurationWireForm.Native;
        foreach (var p in wire.EnumerateObject())
        {
            var raw = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
            switch (p.Name)
            {
                case "decimals":
                    decimals = raw switch
                    {
                        "native" => DecimalWireForm.Native,
                        "string" => DecimalWireForm.String,
                        _ => throw new MetaModelException(
                            $"{path}: \"wire.decimals\" must be one of \"native\", \"string\"",
                            ErrorCode.ERR_BAD_ATTR_VALUE),
                    };
                    break;
                case "nullMembers":
                    nullMembers = raw switch
                    {
                        "native" => NullMemberForm.Native,
                        "emit" => NullMemberForm.Emit,
                        "omit" => NullMemberForm.Omit,
                        _ => throw new MetaModelException(
                            $"{path}: \"wire.nullMembers\" must be one of \"native\", \"emit\", \"omit\"",
                            ErrorCode.ERR_BAD_ATTR_VALUE),
                    };
                    break;
                case "durations":
                    durations = raw switch
                    {
                        "native" => DurationWireForm.Native,
                        "iso" => DurationWireForm.Iso,
                        _ => throw new MetaModelException(
                            $"{path}: \"wire.durations\" must be one of \"native\", \"iso\"",
                            ErrorCode.ERR_BAD_ATTR_VALUE),
                    };
                    break;
                default:
                    throw new MetaModelException(
                        $"{path}: \"wire\" has an unknown key \"{p.Name}\" (expected \"decimals\", \"nullMembers\" and/or \"durations\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return new WireFormat(decimals, nullMembers, durations);
    }

    /// The `api` block: `pagination` takes both `defaultLimit` and `maxLimit` as positive integers with
    /// `defaultLimit <= maxLimit`; `unknownFields` is "reject" (the default) or "drop". Anything else is refused.
    private static ApiSettings ReadApi(JsonElement root, string path)
    {
        if (!root.TryGetProperty("api", out var api)) return ApiSettings.Default;
        if (api.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"api\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

        ApiPagination? pagination = null;
        var unknown = UnknownFieldsMode.Reject;
        foreach (var p in api.EnumerateObject())
        {
            switch (p.Name)
            {
                case "pagination":
                    pagination = ReadPagination(p.Value, path);
                    break;
                case "unknownFields":
                    unknown = (p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null) switch
                    {
                        "reject" => UnknownFieldsMode.Reject,
                        "drop" => UnknownFieldsMode.Drop,
                        _ => throw new MetaModelException(
                            $"{path}: \"api.unknownFields\" must be \"reject\" or \"drop\"", ErrorCode.ERR_BAD_ATTR_VALUE),
                    };
                    break;
                default:
                    throw new MetaModelException(
                        $"{path}: \"api\" has an unknown key \"{p.Name}\" (expected \"pagination\" and/or \"unknownFields\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return new ApiSettings(pagination, unknown);
    }

    private static ApiPagination ReadPagination(JsonElement block, string path)
    {
        if (block.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"api.pagination\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        int? defaultLimit = null, maxLimit = null;
        foreach (var p in block.EnumerateObject())
        {
            switch (p.Name)
            {
                case "defaultLimit": defaultLimit = PageSizeNumber(p.Value, "defaultLimit", path); break;
                case "maxLimit": maxLimit = PageSizeNumber(p.Value, "maxLimit", path); break;
                default:
                    throw new MetaModelException(
                        $"{path}: \"api.pagination\" has an unknown key \"{p.Name}\" (expected \"defaultLimit\" and \"maxLimit\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        if (defaultLimit is null)
            throw new MetaModelException($"{path}: \"api.pagination.defaultLimit\" must be a positive integer", ErrorCode.ERR_BAD_ATTR_VALUE);
        if (maxLimit is null)
            throw new MetaModelException($"{path}: \"api.pagination.maxLimit\" must be a positive integer", ErrorCode.ERR_BAD_ATTR_VALUE);
        if (defaultLimit > maxLimit)
            throw new MetaModelException(
                $"{path}: \"api.pagination.defaultLimit\" must not exceed \"api.pagination.maxLimit\"", ErrorCode.ERR_BAD_ATTR_VALUE);
        return new ApiPagination(defaultLimit.Value, maxLimit.Value);
    }

    // A positive whole number however JSON spells it (50 and 50.0 are one number, as every other
    // port reads them), at most int.MaxValue. The shared corpus
    // fixtures/api-contract-conformance/api-settings/config-blocks.json holds every port to it.
    private static int PageSizeNumber(JsonElement v, string key, string path) =>
        v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var d)
            && d == decimal.Truncate(d) && d >= 1 && d <= int.MaxValue
            ? (int)d
            : throw new MetaModelException($"{path}: \"api.pagination.{key}\" must be a positive integer", ErrorCode.ERR_BAD_ATTR_VALUE);
}

/// <summary>`csharp.packageNamespaces`: <see cref="FromMetadata"/> is the <c>true</c> form (each
/// packaged type takes its metadata package's namespace); <see cref="Map"/> the object form (an
/// explicit package-to-namespace mapping). Both off is the earlier rule.</summary>
public sealed record PackageNamespaceSetting(bool FromMetadata, IReadOnlyDictionary<string, string>? Map)
{
    public static readonly PackageNamespaceSetting Off = new(false, null);
}
