// Result.cs — port of typescript/packages/conformance/src/result.ts.
//
// NormalizedResult: closed-set vocabulary of shapes an `expect` value may produce.
// ResultsEqual: structural equality over the vocabulary.

using System.Text.Json;
using System.Text.Json.Nodes;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// A normalized result — one of the closed set of shapes that a capability
/// invocation or fixture <c>expect</c> value may produce.
/// Backed internally by a <see cref="JsonObject"/> so the same equality code
/// handles both fixture-deserialized and binding-produced values.
/// </summary>
public sealed class NormalizedResult
{
    private readonly JsonObject _node;

    public NormalizedResult(JsonObject node) => _node = node;

    internal JsonObject Node => _node;

    // ── Factory methods ──────────────────────────────────────────────────────

    /// <summary>{ "names": ["a", "b", ...] }</summary>
    public static NormalizedResult Names(IReadOnlyList<string> names)
    {
        var arr = new JsonArray();
        foreach (var n in names) arr.Add(JsonValue.Create(n));
        return new NormalizedResult(new JsonObject { ["names"] = arr });
    }

    /// <summary>{ "name": "x" }</summary>
    public static NormalizedResult Name(string name) =>
        new(new JsonObject { ["name"] = JsonValue.Create(name) });

    /// <summary>{ "absent": true }</summary>
    public static NormalizedResult Absent() =>
        new(new JsonObject { ["absent"] = JsonValue.Create(true) });

    /// <summary>{ "scalar": value } — value may be string, long, double, bool, or null.</summary>
    public static NormalizedResult Scalar(object? value)
    {
        JsonNode? jsonVal = value switch
        {
            null => null,
            bool b => JsonValue.Create(b),
            long l => JsonValue.Create(l),
            int i => JsonValue.Create((long)i),
            double d => JsonValue.Create(d),
            float f => JsonValue.Create((double)f),
            string s => JsonValue.Create(s),
            _ => JsonValue.Create(value.ToString()),
        };
        return new(new JsonObject { ["scalar"] = jsonVal });
    }

    /// <summary>{ "subtype": "primary" }</summary>
    public static NormalizedResult Subtype(string subType) =>
        new(new JsonObject { ["subtype"] = JsonValue.Create(subType) });

    /// <summary>{ "effective-tree": serialized }</summary>
    public static NormalizedResult EffectiveTree(string serialized) =>
        new(new JsonObject { ["effective-tree"] = JsonValue.Create(serialized) });

    /// <summary>{ "error": { "code": code } }</summary>
    public static NormalizedResult Error(string code) =>
        new(new JsonObject { ["error"] = new JsonObject { ["code"] = JsonValue.Create(code) } });

    /// <summary>
    /// Build a <see cref="NormalizedResult"/> from a fixture's <c>expect</c> JSON element.
    /// Produces the same canonical shape as the static factory methods so
    /// <see cref="ResultsEqual.Equal"/> works.
    /// </summary>
    public static NormalizedResult FromJson(JsonElement json)
    {
        // Convert the JsonElement to a JsonNode — JsonNode.Parse handles all value kinds.
        var node = JsonNode.Parse(json.GetRawText());
        if (node is not JsonObject obj)
            throw new InvalidOperationException(
                $"expect value must be a JSON object, got {json.ValueKind}");
        return new NormalizedResult(obj);
    }
}

/// <summary>
/// Structural equality over the normalized result vocabulary.
/// Mirrors <c>resultsEqual</c> in typescript/packages/conformance/src/result.ts.
/// </summary>
public static class ResultsEqual
{
    public static bool Equal(NormalizedResult a, NormalizedResult b)
    {
        var an = a.Node;
        var bn = b.Node;

        // { names: [...] } — element-wise ordered equality
        if (an.ContainsKey("names") && bn.ContainsKey("names"))
        {
            var aN = an["names"]?.AsArray();
            var bN = bn["names"]?.AsArray();
            if (aN is null || bN is null) return false;
            if (aN.Count != bN.Count) return false;
            for (int i = 0; i < aN.Count; i++)
            {
                if (aN[i]?.GetValue<string>() != bN[i]?.GetValue<string>()) return false;
            }
            return true;
        }

        // { name: "x" }
        if (an.ContainsKey("name") && bn.ContainsKey("name"))
            return an["name"]?.GetValue<string>() == bn["name"]?.GetValue<string>();

        // { absent: true }
        if (an.ContainsKey("absent") && bn.ContainsKey("absent"))
            return true;

        // { scalar: value } — null/bool/string/number
        if (an.ContainsKey("scalar") && bn.ContainsKey("scalar"))
            return ScalarsEqual(an["scalar"], bn["scalar"]);

        // { subtype: "x" }
        if (an.ContainsKey("subtype") && bn.ContainsKey("subtype"))
            return an["subtype"]?.GetValue<string>() == bn["subtype"]?.GetValue<string>();

        // { "effective-tree": "..." }
        if (an.ContainsKey("effective-tree") && bn.ContainsKey("effective-tree"))
            return an["effective-tree"]?.GetValue<string>() == bn["effective-tree"]?.GetValue<string>();

        // { error: { code: "..." } } — equality by code ONLY (message and path are not part of the contract)
        if (an.ContainsKey("error") && bn.ContainsKey("error"))
        {
            var aErr = an["error"]?.AsObject();
            var bErr = bn["error"]?.AsObject();
            if (aErr is null || bErr is null) return false;
            return aErr["code"]?.GetValue<string>() == bErr["code"]?.GetValue<string>();
        }

        return false;
    }

    private static bool ScalarsEqual(JsonNode? a, JsonNode? b)
    {
        if (a is null && b is null) return true;
        if (a is null || b is null) return false;

        // Both are JsonValue — compare by their JSON representation to handle
        // bool/string/number uniformly without re-boxing via GetValue<T>.
        return a.ToJsonString() == b.ToJsonString();
    }
}
