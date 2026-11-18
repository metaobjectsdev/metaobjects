// ReferenceValidation — the validation envelope the hand-rolled reference servers answer with:
// { "error": "validation", "issues": [ { "code", "path", "message" } ] }, the shape the TypeScript
// routes use (Zod's issue codes; `path` is the wire field name).

namespace MetaObjects.IntegrationTests.Api;

internal static class ReferenceValidation
{
    public static Dictionary<string, object?> Issue(string code, string field, string message) => new()
    {
        ["code"] = code,
        ["path"] = new List<object?> { field },
        ["message"] = message,
    };

    public static Dictionary<string, object?> Envelope(IEnumerable<Dictionary<string, object?>> issues) => new()
    {
        ["error"] = "validation",
        ["issues"] = issues.Cast<object?>().ToList(),
    };

    /// <summary>The body as a whole cannot be read: one issue with an empty path.</summary>
    public static Dictionary<string, object?> Unreadable() => Envelope(
    [
        new Dictionary<string, object?>
        {
            ["code"] = "invalid_type",
            ["path"] = new List<object?>(),
            ["message"] = "the request body is not a JSON object",
        },
    ]);

    /// <summary>A required key that is absent or null.</summary>
    public static Dictionary<string, object?> Required(string field) =>
        Issue("invalid_type", field, $"{field} is required");

    /// <summary>A present string over its max length.</summary>
    public static Dictionary<string, object?> TooLong(string field, int max) =>
        Issue("too_big", field, $"{field} must be at most {max} characters");

    /// <summary>
    /// <c>api.unknownFields: reject</c> (the default, which the core corpus does not change): the body keys the
    /// entity does not declare, sorted ordinally, as the 400 body, or null when there are none.
    /// </summary>
    public static Dictionary<string, object?>? UnknownFields(IEnumerable<string> bodyKeys, ISet<string> declared)
    {
        var unknown = bodyKeys.Where(k => !declared.Contains(k)).Distinct(StringComparer.Ordinal).ToList();
        if (unknown.Count == 0) return null;
        unknown.Sort(StringComparer.Ordinal);
        return new Dictionary<string, object?> { ["error"] = "unknown_fields", ["fields"] = unknown.Cast<object?>().ToList() };
    }
}
