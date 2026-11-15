// SerializerKeys — the JSON key the host's serializer gives a CLR property, read from the
// serializer's own contract (JsonSerializerOptions.GetTypeInfo) and never re-derived from names.
//
// A generated entity property carries no [JsonPropertyName]; its key is whatever the host's
// JsonSerializerOptions make of it: a naming policy (CamelCase, SnakeCaseLower, KebabCaseLower, a
// custom one), a property-naming resolver's rename, an attribute an adopter's emit hook added, or a
// JsonTypeInfo modifier. The generated routes need that key in two places: to omit a credential from
// a response, and to find which property a PATCH or PUT body key names. Both ask here, so they
// agree with the serializer by construction under every policy.
//
// Part of the codegen runtime surface, referenced by the generated routes.

using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace MetaObjects.Codegen.Runtime;

public static class SerializerKeys
{
    /// <summary>
    /// The JSON keys under which <paramref name="options"/> writes the CLR properties named
    /// <paramref name="clrNames"/> on every runtime type found in <paramref name="body"/> (a row, a list of
    /// rows, or, with <paramref name="envelope"/>, the <c>rows</c> of a <c>{ rows, total }</c> envelope). A
    /// polymorphic list contributes each element's own type, so a subtype-declared property is found.
    /// </summary>
    public static HashSet<string> KeysOf(object? body, bool envelope, JsonSerializerOptions options, IReadOnlyCollection<string> clrNames)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in RowTypes(body, envelope))
        {
            var info = options.GetTypeInfo(type);
            if (info.Kind != JsonTypeInfoKind.Object) continue;
            foreach (var p in info.Properties)
                if (p.AttributeProvider is MemberInfo member && clrNames.Contains(member.Name))
                    keys.Add(p.Name);
        }
        return keys;
    }

    /// <summary>Remove every key in <paramref name="keys"/> from the object, or from each object of the array.</summary>
    public static void Strip(JsonNode? node, HashSet<string> keys)
    {
        if (keys.Count == 0) return;
        if (node is JsonArray a) { foreach (var e in a) Strip(e, keys); return; }
        if (node is not JsonObject o) return;
        foreach (var key in o.Select(p => p.Key).Where(keys.Contains).ToList()) o.Remove(key);
    }

    /// <summary>
    /// The map from a body's JSON key (compared ignoring case, as the PATCH merge always has) to the CLR
    /// property name <paramref name="options"/> gives that key on <paramref name="type"/>.
    /// </summary>
    public static Dictionary<string, string> PropertyByKey(Type type, JsonSerializerOptions options)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var info = options.GetTypeInfo(type);
        if (info.Kind != JsonTypeInfoKind.Object) return map;
        foreach (var p in info.Properties)
            if (p.AttributeProvider is MemberInfo member)
                map.TryAdd(p.Name, member.Name);
        return map;
    }

    private static IEnumerable<Type> RowTypes(object? body, bool envelope)
    {
        if (body is null) yield break;
        object? rows = body;
        if (envelope && body.GetType().GetProperty("rows") is { } rowsProp) rows = rowsProp.GetValue(body);
        if (rows is null) yield break;
        if (rows is IEnumerable list and not string)
        {
            var seen = new HashSet<Type>();
            foreach (var e in list)
                if (e is not null && seen.Add(e.GetType())) yield return e.GetType();
            yield break;
        }
        yield return rows.GetType();
    }
}
