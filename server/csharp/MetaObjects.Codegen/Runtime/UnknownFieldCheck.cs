// UnknownFieldCheck — the `api.unknownFields: reject` answer of a generated create, PUT or PATCH route.
//
//   400 { "error": "unknown_fields", "fields": [ "isAdmin", "nickname" ] }
//
// The top-level keys of the JSON object body that the entity does not declare (for a single-table
// hierarchy: that no field of the base or any subtype declares), sorted by code point (the order every
// port lists them in), listed once each. A declared key the client may not set (the generated key, a readOnly field, a frozen field) is
// not unknown: the route drops it as it always did, so a client that echoes back a row it read works.
// Under `api.unknownFields: drop` the route never calls this.

using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace MetaObjects.Codegen.Runtime;

/// <summary>The unknown-field refusal of a generated write route.</summary>
public static class UnknownFieldCheck
{
    /// <summary>The 400 naming every body key not in <paramref name="known"/>, or null when there is none
    /// (or the body is not a JSON object, which the route's own handling answers).</summary>
    public static IResult? Reject(JsonElement body, IReadOnlySet<string> known)
    {
        if (body.ValueKind != JsonValueKind.Object) return null;
        var unknown = new List<string>();
        foreach (var property in body.EnumerateObject())
            if (!known.Contains(property.Name) && !unknown.Contains(property.Name)) unknown.Add(property.Name);
        if (unknown.Count == 0) return null;
        unknown.Sort(CompareCodePoints);
        return Results.BadRequest(new { error = "unknown_fields", fields = unknown });
    }

    /// <summary>Code-point order. <see cref="StringComparer.Ordinal"/> compares UTF-16 code units, which
    /// puts a key outside the Basic Multilingual Plane before U+E000..U+FFFF.</summary>
    public static int CompareCodePoints(string a, string b)
    {
        var x = a.EnumerateRunes();
        var y = b.EnumerateRunes();
        while (true)
        {
            var hasX = x.MoveNext();
            var hasY = y.MoveNext();
            if (!hasX || !hasY) return hasX.CompareTo(hasY);
            var c = x.Current.Value.CompareTo(y.Current.Value);
            if (c != 0) return c;
        }
    }
}
