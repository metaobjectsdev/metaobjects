// Port-neutral `.metaobjects/config.json` reading.
//
// Reads the NEUTRAL SUBSET (`schema_version`, `sources`, `libraries`). The file also
// carries TypeScript-owned keys (`pending_in_git`, `confidence_thresholds`,
// `extract`, `migrate`, `scope`); those are IGNORED rather than modeled, so a
// new TS-only key never becomes a four-port change. `scope` in particular is
// entirely out of scope for this reader — see
// docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md §4.
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
// `csharp.outDir` is the C#-scoped generated-code directory; the other ports ignore the block.
//
// `wire` (ADR-0019 Amendment 2) is read here too — the output form of a generated REST surface
// (`decimals`, `nullMembers`), refused exactly as `naming` is.
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

    /// ADR-0058 — the project's physical-naming rules (`naming` in config.json), each
    /// absent rule at its default. Never null: an absent `naming` key is the default,
    /// same as an empty `naming: {}` block.
    public PhysicalNaming Naming { get; }

    /// ADR-0019 Amendment 2 — the project's wire-format setting (`wire` in config.json), each
    /// absent key at its native default. Never null.
    public WireFormat Wire { get; }

    /// The C# port's generated-code directory (`csharp.outDir` in config.json), resolved
    /// against the directory holding `.metaobjects/` so it reads the same from any working
    /// directory. Null when the key is absent. `--out` on the command line wins over it.
    public string? OutDir { get; }

    private NeutralConfig(
        IReadOnlyList<IReadOnlyDictionary<string, string>> sources, IReadOnlyList<string> libraries,
        PhysicalNaming naming, WireFormat wire, string? outDir)
    {
        OutDir = outDir;
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
    public static NeutralConfig? Read(string configDir)
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

            var columns = ColumnNamingStrategy.SnakeCase;
            var tables = TableNamingRule.SnakeCase;
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
                        case "columns":
                            if (p.Value.ValueKind != JsonValueKind.String || !TryParseColumnNaming(p.Value.GetString()!, out columns))
                                throw new MetaModelException(
                                    $"{path}: \"naming.columns\" must be one of \"snake_case\", \"literal\", \"kebab-case\"",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            break;
                        case "tables":
                            if (p.Value.ValueKind != JsonValueKind.String || !TryParseTableNaming(p.Value.GetString()!, out tables))
                                throw new MetaModelException(
                                    $"{path}: \"naming.tables\" must be one of \"snake_case\", \"literal\"",
                                    ErrorCode.ERR_BAD_ATTR_VALUE);
                            break;
                        default:
                            throw new MetaModelException(
                                $"{path}: \"naming\" has an unknown key \"{p.Name}\" (expected \"columns\" and/or \"tables\")",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                }
            }

            // Unknown top-level keys (including `scope`/`migrate`) are IGNORED by
            // design — see the file header.
            return new NeutralConfig(specs, libraries, new PhysicalNaming(columns, tables), ReadWire(root, path),
                ReadOutDir(root, path, configDir));
        }
    }

    /// The `csharp` block: the one C#-scoped setting, `outDir`, where `dotnet meta gen` writes
    /// and `dotnet meta verify` diffs. The other ports ignore the block, as they ignore any key
    /// they do not own. An unknown key, a non-string or empty `outDir`, or a non-object block is
    /// refused, the same rule as `naming`.
    private static string? ReadOutDir(JsonElement root, string path, string configDir)
    {
        if (!root.TryGetProperty("csharp", out var block)) return null;
        if (block.ValueKind != JsonValueKind.Object)
            throw new MetaModelException($"{path}: \"csharp\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);

        string? outDir = null;
        foreach (var p in block.EnumerateObject())
        {
            if (p.Name != "outDir")
                throw new MetaModelException(
                    $"{path}: \"csharp\" has an unknown key \"{p.Name}\" (expected \"outDir\")",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
            if (p.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(p.Value.GetString()))
                throw new MetaModelException(
                    $"{path}: \"csharp.outDir\" must be a non-empty string", ErrorCode.ERR_BAD_ATTR_VALUE);
            outDir = Path.GetFullPath(p.Value.GetString()!, Path.GetFullPath(configDir));
        }
        return outDir;
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
                default:
                    throw new MetaModelException(
                        $"{path}: \"wire\" has an unknown key \"{p.Name}\" (expected \"decimals\" and/or \"nullMembers\")",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return new WireFormat(decimals, nullMembers);
    }

    /// The cross-port spellings (ADR-0058) — not .NET enum names, so the JSON value reads
    /// the same in every port's config.
    private static bool TryParseColumnNaming(string raw, out ColumnNamingStrategy strategy)
    {
        switch (raw)
        {
            case "literal":     strategy = ColumnNamingStrategy.Literal;   return true;
            case "snake_case":  strategy = ColumnNamingStrategy.SnakeCase; return true;
            case "kebab-case":  strategy = ColumnNamingStrategy.KebabCase; return true;
            default:            strategy = ColumnNamingStrategy.Literal;   return false;
        }
    }

    private static bool TryParseTableNaming(string raw, out TableNamingRule rule)
    {
        switch (raw)
        {
            case "literal":    rule = TableNamingRule.Literal;   return true;
            case "snake_case": rule = TableNamingRule.SnakeCase; return true;
            default:           rule = TableNamingRule.Literal;   return false;
        }
    }
}
