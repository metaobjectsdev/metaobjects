// FR5a / ADR-0009 — Cross-port-aligned semantic-equality compare for metadata
// trees. Returns `true` if the two inputs differ in any semantically-meaningful
// way (excluding `source`, which is loader output).
//
// Algorithm (ADR-0009 §semantic_diff):
//   1. Sort attrs lexicographically; compare attr-by-attr; values by canonical
//      structural equality (key-order independent, whitespace-insensitive).
//   2. Children are compared as ordered sequences.
//   3. Reserved structural keys (name, package, extends, abstract, overlay,
//      isArray, value) participate like attrs.
//   4. `source` excluded from the diff.
//
// FR5a does not exercise this — FR5c will consume the boolean to drive the
// duplicate-with-no-change WARN_DUPLICATE_DECLARATION path. We ship the skeleton
// + tests now so the port is ready when FR5c lands.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Meta;

namespace MetaObjects.Source;

/// <summary>
/// Cross-port semantic equality over metadata trees. See ADR-0009.
/// </summary>
public static class SemanticDiff
{
    private static readonly HashSet<string> Excluded = new(StringComparer.Ordinal) { "source" };

    /// <summary>
    /// Returns <see langword="true"/> when <paramref name="a"/> and
    /// <paramref name="b"/> differ in any semantically-meaningful way; otherwise
    /// <see langword="false"/>. Inputs are object trees of the same shape the
    /// canonical JSON parser consumes.
    /// </summary>
    public static bool Diff(JsonNode? a, JsonNode? b) => !Equal(a, b);

    /// <summary>
    /// MetaData overload: serializes both nodes to canonical JSON and diffs the
    /// resulting trees. Useful for the overlay-merge consumer in FR5c.
    /// </summary>
    public static bool Diff(MetaData a, MetaData b)
    {
        string serializedA = SerializerJson.CanonicalSerialize(a);
        string serializedB = SerializerJson.CanonicalSerialize(b);
        // Fast path: byte-identical canonical output → no diff.
        if (string.Equals(serializedA, serializedB, StringComparison.Ordinal)) return false;
        JsonNode? nodeA = JsonNode.Parse(serializedA);
        JsonNode? nodeB = JsonNode.Parse(serializedB);
        return Diff(nodeA, nodeB);
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    private static bool Equal(JsonNode? a, JsonNode? b)
    {
        if (a is null && b is null) return true;
        if (a is null || b is null) return false;

        switch (a)
        {
            case JsonArray arrA when b is JsonArray arrB:
            {
                if (arrA.Count != arrB.Count) return false;
                for (int i = 0; i < arrA.Count; i++)
                {
                    if (!Equal(arrA[i], arrB[i])) return false;
                }
                return true;
            }
            case JsonObject objA when b is JsonObject objB:
            {
                var aKeys = objA.Where(p => !Excluded.Contains(p.Key))
                                .Select(p => p.Key)
                                .OrderBy(k => k, StringComparer.Ordinal)
                                .ToList();
                var bKeys = objB.Where(p => !Excluded.Contains(p.Key))
                                .Select(p => p.Key)
                                .OrderBy(k => k, StringComparer.Ordinal)
                                .ToList();
                if (aKeys.Count != bKeys.Count) return false;
                for (int i = 0; i < aKeys.Count; i++)
                {
                    if (!string.Equals(aKeys[i], bKeys[i], StringComparison.Ordinal)) return false;
                    if (!Equal(objA[aKeys[i]], objB[bKeys[i]])) return false;
                }
                return true;
            }
            case JsonValue valA when b is JsonValue valB:
            {
                // Compare by underlying JSON text — collapses 1 vs 1.0 / true vs True etc.
                return string.Equals(
                    valA.ToJsonString(),
                    valB.ToJsonString(),
                    StringComparison.Ordinal);
            }
            default:
                return false;
        }
    }
}
