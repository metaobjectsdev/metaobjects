// Port-neutral `.metaobjects/config.json` reading.
//
// Reads only the NEUTRAL SUBSET (`schema_version`, `sources`). The file also
// carries TypeScript-owned keys (`pending_in_git`, `confidence_thresholds`,
// `extract`, `migrate`, `scope`); those are IGNORED rather than modeled, so a
// new TS-only key never becomes a four-port change. `scope` in particular is
// entirely out of scope for this reader — see
// docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md §4.
using System.Text.Json;

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

    private NeutralConfig(IReadOnlyList<IReadOnlyDictionary<string, string>> sources) => Sources = sources;

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

            // Unknown top-level keys (including `scope`/`migrate`) are IGNORED by
            // design — see the file header.
            return new NeutralConfig(specs);
        }
    }
}
