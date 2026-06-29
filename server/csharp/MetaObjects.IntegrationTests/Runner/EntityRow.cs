// EntityRow — project a materialized EF entity to the metadata-field-keyed row
// dictionary the runner normalizes + compares.
//
// Shared by the WRITE read-backs (op: roundtrip insert, op: update) so a re-read
// entity flows through ONE wire projection. The one subtlety vs a raw-jsonb read
// column: an @objectRef field materializes as an owned-type POCO (EF OwnsOne.ToJson),
// not the jsonb string a string-typed column would yield. Project that POCO to a
// field-keyed JSON STRING so it flows through the SAME Normalization jsonb path
// (TryParseJsonContainer → sorted keys) as a read scenario's string-typed jsonb
// column — keeping the wire form identical across read/write and across ports.
// Scalars / temporal / Guid / enum pass straight through to Normalization.

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MetaObjects.IntegrationTests.Runner;

public static class EntityRow
{
    /// <summary>
    /// Public instance properties → lowerCamel-keyed row of wire values. The property
    /// set comes from <paramref name="declaredType"/> (default: the runtime type): a
    /// TPH polymorphic read passes the DECLARED base type so a subtype row projects only
    /// the base's columns (the wire contract the list scenarios assert), not the runtime
    /// subtype's extra columns.
    /// </summary>
    public static IReadOnlyDictionary<string, object?> Of(object entity, Type? declaredType = null)
    {
        var dict = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in (declaredType ?? entity.GetType()).GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var key = char.ToLowerInvariant(prop.Name[0]) + prop.Name[1..];
            dict[key] = WireValue(prop.GetValue(entity));
        }
        return dict;
    }

    private static object? WireValue(object? value)
    {
        if (value is null) return null;
        var t = value.GetType();
        if (t.IsPrimitive || value is string or decimal or DateTime or DateOnly or TimeOnly or Guid or Enum)
            return value;
        // A @dbColumnType:jsonb open-bag surfaces as JsonDocument/JsonElement (issue #98) —
        // pass it through so Normalization re-serializes the parsed value with sorted keys,
        // exactly as a string-typed jsonb column does. NOT a POCO to reflect over.
        if (value is JsonDocument or JsonElement) return value;
        // A nested owned POCO → field-keyed JSON string (Normalization sorts the keys).
        return PocoToJsonNode(value).ToJsonString();
    }

    private static JsonNode PocoToJsonNode(object poco)
    {
        var obj = new JsonObject();
        foreach (var prop in poco.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var key = char.ToLowerInvariant(prop.Name[0]) + prop.Name[1..];
            obj[key] = LeafToJsonNode(prop.GetValue(poco));
        }
        return obj;
    }

    private static JsonNode? LeafToJsonNode(object? v) => v switch
    {
        null => null,
        bool b => JsonValue.Create(b),
        string s => JsonValue.Create(s),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        decimal dec => JsonValue.Create(dec),
        Enum e => JsonValue.Create(e.ToString()),
        _ when v.GetType().IsClass => PocoToJsonNode(v),   // nested value object
        _ => JsonValue.Create(v.ToString()),
    };
}
