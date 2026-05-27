// FR5b — YAML authoring source-position carrier (per ADR-0009).
//
// C# port of:
//   server/typescript/packages/metadata/src/core/yaml-positions.ts           (carrier + helpers)
//   server/typescript/packages/metadata/src/core/yaml-positions-walker.ts    (YAML AST → JSON walker)
//
// Carrier design (vs TS):
//
//   TS uses a well-known Symbol-keyed, non-enumerable property on every
//   wrapper-mapping object. It "rides with the node" — invisible to
//   JSON.stringify, no parallel data structure to keep in sync, and survives
//   shallow-copy through the desugar.
//
//   C# JsonObject (System.Text.Json.Nodes) doesn't support per-instance
//   hidden properties the way a JS object does. The closest analogue is
//   ConditionalWeakTable<JsonObject, PositionMap> — keyed by JsonObject
//   reference, invisible to ToJsonString(), GC'd when the JsonObject is.
//   That's what we use here. The desugar carries the table across rule
//   rewrites by attaching the same/transformed PositionMap to the newly-
//   produced JsonObjects.
//
//   The walker (here) builds the table during YamlNode → JsonObject
//   conversion; the desugar (YamlDesugar.cs) carries it through Rules 1-5;
//   ParserYaml flattens the table to a JSONPath-keyed dictionary at the
//   end of desugar (the JsonObject references would otherwise be lost when
//   Parser walks JsonElement — we sidestep that by passing the flat dict
//   through ParseOptions so the parser can stamp source.yamlPosition by
//   JSONPath lookup).
//
//   Skip yamlPosition on desugar-synthesized nodes (Rule 3's empty body —
//   no body-side positions to inherit); inherit on Rule-2's scalar-body
//   `name` slot (use the wrapper key's position); preserve on Rule-4's
//   `[]` strip and Rule-5's `@`-prefix rewrite. Matches the TS reference.

using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using MetaObjects.Source;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace MetaObjects;

/// <summary>The position-by-key map attached to a mapping object.</summary>
public sealed class PositionMap
{
    private readonly Dictionary<string, YamlPosition> _positions =
        new(StringComparer.Ordinal);

    /// <summary>Get the position for <paramref name="key"/>, or null if absent.</summary>
    public YamlPosition? Get(string key) =>
        _positions.TryGetValue(key, out YamlPosition? p) ? p : null;

    /// <summary>Set the position for <paramref name="key"/>.</summary>
    public void Set(string key, YamlPosition pos) => _positions[key] = pos;

    /// <summary>True when at least one key has a recorded position.</summary>
    public bool Any => _positions.Count > 0;

    /// <summary>Enumerate every (key, position) pair on this map.</summary>
    public IEnumerable<KeyValuePair<string, YamlPosition>> Entries => _positions;
}

/// <summary>
/// Static helpers for attaching / reading the position-by-key map on a
/// <see cref="JsonObject"/>. The backing store is a process-local
/// <see cref="ConditionalWeakTable{TKey, TValue}"/> so the map is GC'd with the
/// owning JsonObject and is invisible to <c>ToJsonString()</c>.
/// </summary>
public static class YamlPositions
{
    private static readonly ConditionalWeakTable<JsonObject, PositionMap> _store = new();

    /// <summary>Read the position-by-key map from a JsonObject, if any.</summary>
    public static PositionMap? GetMap(JsonObject? obj)
    {
        if (obj is null) return null;
        return _store.TryGetValue(obj, out PositionMap? map) ? map : null;
    }

    /// <summary>Read the position for a specific key on a JsonObject.</summary>
    public static YamlPosition? Get(JsonObject? obj, string key)
    {
        PositionMap? map = GetMap(obj);
        return map?.Get(key);
    }

    /// <summary>
    /// Attach (or replace) the position-by-key map on a JsonObject. The map
    /// lives in a side table — neither serialized by <c>ToJsonString()</c> nor
    /// visible to enumeration of the JsonObject's properties.
    /// </summary>
    public static void SetMap(JsonObject obj, PositionMap positions)
    {
        _store.Remove(obj);
        _store.Add(obj, positions);
    }
}

/// <summary>
/// YAML AST → JSON walker that preserves source positions.
///
/// <para>
/// Mirrors <c>parseYamlWithPositions</c> in
/// <c>typescript/packages/metadata/src/core/yaml-positions-walker.ts</c>.
/// For each YAML mapping, attaches a position-by-key map to the resulting
/// <see cref="JsonObject"/>: the position of each key is the (line, col) of
/// the KEY token in the YAML source.
/// </para>
///
/// <para>
/// Note — this walker is a standalone inspection tool that produces the RAW
/// (non-desugared) JSON shape. The production pipeline integrates
/// position-attachment directly into <see cref="YamlDesugar"/>, which reads
/// positions off the YAML AST during its Rule 1-5 walk in a single pass.
/// This walker is retained because (a) it mirrors the TS reference's
/// <c>parseYamlWithPositions</c> layering and (b) its single-purpose output
/// is convenient for walker-level unit tests.
/// </para>
/// </summary>
public static class YamlPositionWalker
{
    /// <summary>
    /// Walk a parsed YAML node tree into a JsonObject (mappings) /
    /// JsonArray (sequences) / JsonValue (scalars) structure, attaching a
    /// <see cref="PositionMap"/> to every JsonObject via
    /// <see cref="YamlPositions"/>. Returns null when the input is null/empty.
    /// </summary>
    public static JsonNode? Walk(YamlNode? node)
    {
        if (node is null) return null;
        if (node is YamlScalarNode scalar) return ScalarToJsonValue(scalar);
        if (node is YamlSequenceNode seq)
        {
            var arr = new JsonArray();
            foreach (YamlNode el in seq.Children) arr.Add(Walk(el));
            return arr;
        }
        if (node is YamlMappingNode map)
        {
            var obj = new JsonObject();
            PositionMap? positions = null;
            foreach (KeyValuePair<YamlNode, YamlNode> kvp in map.Children)
            {
                if (kvp.Key is not YamlScalarNode keyScalar || keyScalar.Value is null) continue;
                string keyText = keyScalar.Value;
                obj[keyText] = Walk(kvp.Value);
                Mark start = keyScalar.Start;
                if (start.Line > 0 || start.Column > 0)
                {
                    positions ??= new PositionMap();
                    positions.Set(keyText, new YamlPosition((int)start.Line, (int)start.Column));
                }
            }
            if (positions is not null && positions.Any)
            {
                YamlPositions.SetMap(obj, positions);
            }
            return obj;
        }
        // Aliases, tags — fall back to null. The authoring grammar doesn't use them.
        return null;
    }

    // -----------------------------------------------------------------------
    // Scalar conversion — duplicates the typed-scalar logic from YamlDesugar.
    // Kept local so the walker is self-contained; the desugar runs the same
    // conversion on the values it descends into (the walker pre-populates
    // values for the desugar's body-key iteration).
    // -----------------------------------------------------------------------

    private static JsonNode? ScalarToJsonValue(YamlScalarNode scalar)
    {
        string? tag = scalar.Tag.IsEmpty ? null : scalar.Tag.Value;
        string? raw = scalar.Value;

        if (tag == "tag:yaml.org,2002:null") return null;
        if (raw is null) return null;

        // Quoted scalars are always strings.
        if (scalar.Style == ScalarStyle.SingleQuoted
            || scalar.Style == ScalarStyle.DoubleQuoted
            || scalar.Style == ScalarStyle.Literal
            || scalar.Style == ScalarStyle.Folded)
        {
            return JsonValue.Create(raw);
        }

        if (tag == "tag:yaml.org,2002:str") return JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:bool") return ParseBool(raw) ?? JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:int") return ParseInt(raw) ?? JsonValue.Create(raw);
        if (tag == "tag:yaml.org,2002:float") return ParseFloat(raw) ?? JsonValue.Create(raw);

        // Plain scalars — YAML 1.2 core schema, order matters.
        if (raw == "" || raw == "~" || raw == "null" || raw == "Null" || raw == "NULL")
            return null;
        JsonNode? maybeBool = ParseBool(raw);
        if (maybeBool is not null) return maybeBool;
        JsonNode? maybeInt = ParseInt(raw);
        if (maybeInt is not null) return maybeInt;
        JsonNode? maybeFloat = ParseFloat(raw);
        if (maybeFloat is not null) return maybeFloat;
        return JsonValue.Create(raw);
    }

    private static JsonNode? ParseBool(string raw)
    {
        if (raw == "true" || raw == "True" || raw == "TRUE") return JsonValue.Create(true);
        if (raw == "false" || raw == "False" || raw == "FALSE") return JsonValue.Create(false);
        return null;
    }

    private static JsonNode? ParseInt(string raw)
    {
        if (long.TryParse(raw, System.Globalization.NumberStyles.AllowLeadingSign,
            System.Globalization.CultureInfo.InvariantCulture, out long l))
        {
            if (!raw.Contains('.') && !raw.Contains('e') && !raw.Contains('E'))
            {
                return JsonValue.Create(l);
            }
        }
        return null;
    }

    private static JsonNode? ParseFloat(string raw)
    {
        if (raw == ".inf" || raw == ".Inf" || raw == ".INF") return JsonValue.Create(double.PositiveInfinity);
        if (raw == "-.inf" || raw == "-.Inf" || raw == "-.INF") return JsonValue.Create(double.NegativeInfinity);
        if (raw == ".nan" || raw == ".NaN" || raw == ".NAN") return JsonValue.Create(double.NaN);

        if (double.TryParse(raw, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double d))
        {
            if (raw.Contains('.') || raw.Contains('e') || raw.Contains('E'))
            {
                return JsonValue.Create(d);
            }
        }
        return null;
    }
}
