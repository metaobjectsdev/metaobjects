// OperationScript — port of typescript/packages/conformance/src/operation-script.ts.
//
// ParseExpectedErrors: validates expected-errors.json is [{code: string}...], returns codes.
// ParseOperationScript: validates script.json {operations: Operation[]} schema.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// One entry from a script.json operations array.
/// </summary>
/// <param name="Navigate">Path segments — colon-form <c>type:name</c> or bracket-form <c>type[subType]</c>.</param>
/// <param name="Invoke">Capability-id in <c>type.capability</c> form.</param>
/// <param name="Args">Optional flat map of scalar arguments.</param>
/// <param name="Expect">The expected normalized result (raw JSON element).</param>
public sealed record Operation(
    IReadOnlyList<string> Navigate,
    string Invoke,
    IReadOnlyDictionary<string, object?>? Args,
    JsonElement Expect);

/// <summary>
/// Parsed script.json.
/// </summary>
/// <param name="Operations">The ordered list of operations to execute.</param>
public sealed record OperationScript(IReadOnlyList<Operation> Operations);

/// <summary>
/// Parsers for expected-errors.json and script.json.
/// </summary>
public static class OperationScriptParser
{
    // capability-id grammar: <type>.<capability>, both kebab-case.
    private static readonly Regex CapabilityIdPattern =
        new(@"^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$", RegexOptions.Compiled);

    /// <summary>
    /// Parse and validate a parsed expected-errors.json value.
    /// Throws a clear exception if the element is not an array of objects each
    /// with a string <c>code</c> field.
    /// </summary>
    /// <returns>The list of error codes.</returns>
    public static IReadOnlyList<string> ParseExpectedErrors(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("expected-errors.json must be a JSON array");

        var codes = new List<string>();
        int i = 0;
        foreach (var item in root.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException(
                    $"expected-errors.json entry {i} is not an object");

            if (!item.TryGetProperty("code", out var codeProp) ||
                codeProp.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException(
                    $"expected-errors.json entry {i} missing string 'code' field");

            codes.Add(codeProp.GetString()!);
            i++;
        }
        return codes;
    }

    /// <summary>
    /// Parse and validate a parsed script.json object.
    /// Throws a clear exception on a malformed script.
    /// </summary>
    public static OperationScript ParseOperationScript(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("operations", out var opsEl))
            throw new InvalidOperationException(
                "script.json must be an object with an 'operations' key");

        if (opsEl.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("script.json 'operations' must be an array");

        var operations = new List<Operation>();
        int i = 0;
        foreach (var op in opsEl.EnumerateArray())
        {
            if (op.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException($"operation {i} is not an object");

            if (!op.TryGetProperty("navigate", out var navEl) ||
                navEl.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException($"operation {i}: 'navigate' must be an array");

            var navigate = navEl.EnumerateArray()
                .Select((seg, si) =>
                {
                    if (seg.ValueKind != JsonValueKind.String)
                        throw new InvalidOperationException(
                            $"operation {i}: navigate[{si}] is not a string");
                    return seg.GetString()!;
                })
                .ToList();

            if (!op.TryGetProperty("invoke", out var invokeEl) ||
                invokeEl.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException($"operation {i}: 'invoke' is required");

            var invoke = invokeEl.GetString()!;
            if (!CapabilityIdPattern.IsMatch(invoke))
                throw new InvalidOperationException(
                    $"operation {i}: malformed capability-id '{invoke}'");

            if (!op.TryGetProperty("expect", out var expectEl) ||
                expectEl.ValueKind == JsonValueKind.Undefined)
                throw new InvalidOperationException($"operation {i}: 'expect' is required");

            IReadOnlyDictionary<string, object?>? args = null;
            if (op.TryGetProperty("args", out var argsEl) &&
                argsEl.ValueKind == JsonValueKind.Object)
            {
                var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var prop in argsEl.EnumerateObject())
                {
                    object? val = prop.Value.ValueKind switch
                    {
                        JsonValueKind.String => prop.Value.GetString(),
                        JsonValueKind.Number when prop.Value.TryGetInt64(out var l) => (object?)l,
                        JsonValueKind.Number => prop.Value.GetDouble(),
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        _ => prop.Value.ToString(),
                    };
                    dict[prop.Name] = val;
                }
                args = dict;
            }

            operations.Add(new Operation(navigate, invoke, args, expectEl));
            i++;
        }

        return new OperationScript(operations);
    }
}
