using System.Text.Json;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Converts a payload.json document into the plain object graph the render engine
/// (Stubble) consumes: objects -> Dictionary&lt;string, object&gt;, arrays ->
/// List&lt;object&gt;, integral numbers -> long (so "2" renders as "2", not "2.0"),
/// fractional -> double, plus string/bool/null.
/// </summary>
public static class JsonPayload
{
    public static object? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return Convert(doc.RootElement);
    }

    private static object? Convert(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => ToDict(el),
        JsonValueKind.Array  => ToList(el),
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : el.GetDouble(),
        JsonValueKind.True   => true,
        JsonValueKind.False  => false,
        _                    => null,
    };

    private static Dictionary<string, object> ToDict(JsonElement el)
    {
        var d = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var p in el.EnumerateObject())
            d[p.Name] = Convert(p.Value)!;
        return d;
    }

    private static List<object> ToList(JsonElement el)
    {
        var list = new List<object>();
        foreach (var e in el.EnumerateArray())
            list.Add(Convert(e)!);
        return list;
    }
}
