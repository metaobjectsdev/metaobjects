// RouteErrors — the two request refusals a generated route names before it touches the store.
//
//   400 { "error": "invalid_json" }   a body that is not JSON at all
//   400 { "error": "invalid_id" }     a path id the key's type cannot hold
//
// The REST standard (docs/features/api-contract.md) answers both with a named body, where ASP.NET
// Core's own binding would answer an empty 400 for the id and the route a validation body for the
// JSON. A body that is JSON but not an object is still the validation answer (`invalid_type`).

using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using Microsoft.AspNetCore.Http;

namespace MetaObjects.AspNetCore;

/// <summary>The <c>invalid_json</c> and <c>invalid_id</c> answers of a generated route.</summary>
public static class RouteErrors
{
    /// <summary>The wire code of a body that is not JSON.</summary>
    public const string InvalidJsonCode = "invalid_json";

    /// <summary>The wire code of a path id the key cannot hold.</summary>
    public const string InvalidIdCode = "invalid_id";

    /// <summary><c>400 {"error": "invalid_json"}</c>.</summary>
    public static IResult InvalidJson() => Results.BadRequest(new Dictionary<string, object?> { ["error"] = InvalidJsonCode });

    /// <summary><c>400 {"error": "invalid_id"}</c>.</summary>
    public static IResult InvalidId() => Results.BadRequest(new Dictionary<string, object?> { ["error"] = InvalidIdCode });

    /// <summary>
    /// Read the route value <paramref name="name"/> as the key type <typeparamref name="T"/>, with the
    /// invariant culture (the parse ASP.NET Core's own binding uses). False when the text is absent
    /// or no value of the type; the route then answers <see cref="InvalidId"/>.
    /// </summary>
    public static bool TryReadId<T>(HttpContext http, [MaybeNullWhen(false)] out T id, string name = "id") where T : IParsable<T>
    {
        if (http.Request.RouteValues.TryGetValue(name, out var raw) && raw?.ToString() is { } text
            && T.TryParse(text, CultureInfo.InvariantCulture, out id))
            return true;
        id = default;
        return false;
    }
}
