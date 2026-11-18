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
    /// Fails closed: see <see cref="KeysOfType"/>.
    /// </summary>
    public static HashSet<string> KeysOf(object? body, bool envelope, JsonSerializerOptions options, IReadOnlyCollection<string> clrNames)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in RowTypes(body, envelope))
            keys.UnionWith(KeysOfType(type, options, clrNames));
        return keys;
    }

    /// <summary>
    /// The JSON keys <paramref name="options"/> writes the credential properties of <paramref name="type"/> under,
    /// read from the serializer's contract. A type that declares none of <paramref name="clrNames"/> contributes
    /// nothing. For a type that does, this THROWS rather than guess when the contract cannot be read:
    /// its kind is not an object (a custom converter), any property has no reflection member behind it
    /// (a custom type-info resolver, a modifier that rebuilds properties, a source-generated context that does
    /// not carry it), or a credential has no matching property in the contract. A response that cannot be
    /// stripped is refused, never sent. The message names the type and the credential property, never a value.
    /// </summary>
    public static HashSet<string> KeysOfType(Type type, JsonSerializerOptions options, IReadOnlyCollection<string> clrNames)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        var declared = clrNames
            .Where(n => type.GetProperty(n, BindingFlags.Public | BindingFlags.Instance) is { } prop && !IsIgnored(prop))
            .Distinct(StringComparer.Ordinal).ToList();
        if (declared.Count == 0) return keys;

        JsonTypeInfo info;
        try { info = options.GetTypeInfo(type); }
        catch (NotSupportedException e) { throw Unreadable(type, declared, "the serializer has no contract for it (" + e.GetType().Name + ")"); }
        if (info.Kind != JsonTypeInfoKind.Object)
            throw Unreadable(type, declared, $"its JSON contract is a {info.Kind}, not an object (a custom converter?)");
        if (info.Properties.Any(p => p.AttributeProvider is not MemberInfo))
            throw Unreadable(type, declared, "a property has no reflection member behind it (a custom type-info resolver, a modifier that rebuilds properties, or a source-generated context?)");
        foreach (var name in declared)
        {
            var matched = info.Properties.Where(p => ((MemberInfo)p.AttributeProvider!).Name == name).Select(p => p.Name).ToList();
            if (matched.Count == 0) throw Unreadable(type, [name], "the credential has no property in the serializer's contract");
            keys.UnionWith(matched);
        }
        return keys;
    }

    /// <summary>
    /// Check, at startup (the generated route mapping calls it), that the credential properties of
    /// <paramref name="types"/> can be stripped under the host's configured <c>JsonOptions</c>. Throws as
    /// <see cref="KeysOfType"/> does, so a host whose serializer contract cannot be read fails to start
    /// instead of failing on the first response.
    /// </summary>
    public static void EnsureContract(IServiceProvider services, IReadOnlyCollection<Type> types, IReadOnlyCollection<string> clrNames)
    {
        var options = (services.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))
            as Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)?.Value.SerializerOptions
            ?? JsonSerializerOptions.Default;
        foreach (var type in types) KeysOfType(type, options, clrNames);
    }

    private static bool IsIgnored(PropertyInfo prop) =>
        prop.GetCustomAttribute<System.Text.Json.Serialization.JsonIgnoreAttribute>() is { Condition: System.Text.Json.Serialization.JsonIgnoreCondition.Always };

    private static InvalidOperationException Unreadable(Type type, IEnumerable<string> credentials, string why) =>
        new($"cannot strip the credential {string.Join(", ", credentials.Select(c => type.Name + "." + c))} from a response: {why}. " +
            "Credential stripping reads the serializer's reflection-visible contract; the response is refused rather than sent unstripped.");

    /// <summary>
    /// Strip the credential properties named <paramref name="clrNames"/> from <paramref name="node"/>, the
    /// serialized form of <paramref name="body"/> under <paramref name="options"/>: from the row, from each row of
    /// a list, or, with <paramref name="envelope"/>, from each row under the <c>rows</c> key of a
    /// <c>{ rows, total }</c> envelope. Every credential-omitting response goes through here. The envelope's
    /// <c>rows</c> key is the serializer's own (a naming policy may write it <c>ROWS</c>), read from the
    /// envelope's contract, never assumed. Fails closed: a credential key that cannot be read (see
    /// <see cref="KeysOfType"/>), an envelope whose <c>rows</c> key cannot be read from its contract, or a node
    /// under that key that is not an array THROWS, so the response is refused rather than sent unstripped.
    /// </summary>
    public static void StripBody(JsonNode? node, object? body, bool envelope, JsonSerializerOptions options, IReadOnlyCollection<string> clrNames)
    {
        var keys = KeysOf(body, envelope, options, clrNames);
        Strip(envelope ? EnvelopeRows(node, body, options) : node, keys, clrNames);
    }

    // The rows array of a serialized { rows, total } envelope, found under the key the serializer's contract
    // gives the envelope's `rows` member. Throws when the key or the array cannot be found.
    private static JsonArray EnvelopeRows(JsonNode? node, object? body, JsonSerializerOptions options)
    {
        const string Rows = "rows";
        static InvalidOperationException Refused(string why) =>
            new($"cannot strip credentials from a {{ rows, total }} response: {why}. The response is refused rather than sent unstripped.");
        if (body is null || node is not JsonObject env) throw Refused("the body did not serialize to a JSON object");
        JsonTypeInfo info;
        try { info = options.GetTypeInfo(body.GetType()); }
        catch (NotSupportedException e) { throw Refused("the serializer has no contract for the envelope (" + e.GetType().Name + ")"); }
        var key = info.Kind == JsonTypeInfoKind.Object
            ? info.Properties.FirstOrDefault(p => p.AttributeProvider is MemberInfo m && m.Name == Rows)?.Name
            : null;
        if (key is null) throw Refused("the serializer's contract for the envelope has no rows property");
        if (!env.TryGetPropertyValue(key, out var rows) || rows is not JsonArray array)
            throw Refused($"the envelope has no array under its rows key \"{key}\"");
        return array;
    }

    /// <summary>
    /// Remove every key in <paramref name="keys"/> from the object, or from each object of the array, and, as a
    /// second line of defence, every key that spells one of <paramref name="names"/> ignoring case, <c>_</c> and
    /// <c>-</c>.
    /// </summary>
    public static void Strip(JsonNode? node, HashSet<string> keys, IReadOnlyCollection<string>? names = null)
    {
        if (keys.Count == 0 && (names is null || names.Count == 0)) return;
        var normalized = names is null ? [] : names.Select(Normalize).ToHashSet(StringComparer.Ordinal);
        StripCore(node, keys, normalized);
    }

    private static void StripCore(JsonNode? node, HashSet<string> keys, HashSet<string> normalized)
    {
        if (node is JsonArray a) { foreach (var e in a) StripCore(e, keys, normalized); return; }
        if (node is not JsonObject o) return;
        foreach (var key in o.Select(p => p.Key).Where(k => keys.Contains(k) || normalized.Contains(Normalize(k))).ToList()) o.Remove(key);
    }

    private static string Normalize(string key) => key.Replace("_", "").Replace("-", "").ToLowerInvariant();

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
