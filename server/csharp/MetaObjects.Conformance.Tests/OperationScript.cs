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
    /// One expected source token for an envelope-shaped expected-errors.json.
    /// The cross-port harness asserts <c>Format</c>, <c>Files</c>, <c>JsonPath</c>.
    /// FR5d — for <c>format=resolved</c> envelopes, <c>Referrer</c> + <c>Target</c>
    /// are required by the schema and asserted by the runner.
    /// </summary>
    public sealed record ExpectedErrorSource(
        string Format,
        IReadOnlyList<string> Files,
        string? JsonPath,
        string? Referrer = null,
        string? Target = null);

    /// <summary>
    /// One expected error in the parsed expected-errors.json. <c>Source</c>
    /// is non-null iff the file used the FR5a envelope shape.
    /// </summary>
    public sealed record ExpectedError(string Code, ExpectedErrorSource? Source);

    /// <summary>
    /// Result of parsing expected-errors.json.
    /// <see cref="Legacy"/> is true when the file used the pre-FR5a
    /// <c>[{code}]</c> array shape (no envelope assertions possible).
    /// <para>
    /// FR5c-finalize — <see cref="Warnings"/> holds per-entry expected warnings
    /// (same shape as <see cref="Errors"/>). When each entry has a non-null
    /// <c>Source</c>, the runner asserts per-warning envelope alignment;
    /// otherwise only the count is asserted.
    /// </para>
    /// </summary>
    public sealed record ExpectedErrorsEnvelope(
        IReadOnlyList<ExpectedError> Errors,
        IReadOnlyList<ExpectedError> Warnings,
        bool Legacy);

    /// <summary>
    /// Parse and validate a parsed expected-errors.json value.
    /// Accepts both shapes:
    /// <list type="bullet">
    /// <item><description><b>Legacy</b> <c>[{code}]</c> — pre-FR5a.</description></item>
    /// <item><description><b>FR5a envelope</b> <c>{ errors: [{code, source}], warnings: [] }</c>.</description></item>
    /// </list>
    /// </summary>
    public static ExpectedErrorsEnvelope ParseExpectedErrorsEnvelope(JsonElement root)
    {
        // Legacy shape — plain array of {code}.
        if (root.ValueKind == JsonValueKind.Array)
        {
            var legacyErrors = new List<ExpectedError>();
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
                legacyErrors.Add(new ExpectedError(codeProp.GetString()!, null));
                i++;
            }
            return new ExpectedErrorsEnvelope(legacyErrors, Array.Empty<ExpectedError>(), Legacy: true);
        }

        // FR5a envelope shape.
        if (root.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException(
                "expected-errors.json must be either an array (legacy) or an object with 'errors'");
        if (!root.TryGetProperty("errors", out var errorsEl) ||
            errorsEl.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException(
                "expected-errors.json: 'errors' must be an array");

        var errors = ParseEnvelopeEntryArray(errorsEl, "errors");

        // FR5c-finalize — warnings entries are parsed with the same envelope
        // shape as errors. When a fixture omits `source` on a warning entry,
        // the runner asserts only the count for that entry.
        IReadOnlyList<ExpectedError> warnings = Array.Empty<ExpectedError>();
        if (root.TryGetProperty("warnings", out var warnEl))
        {
            if (warnEl.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException(
                    "expected-errors.json: 'warnings' must be an array");
            warnings = ParseEnvelopeEntryArray(warnEl, "warnings");
        }
        return new ExpectedErrorsEnvelope(errors, warnings, Legacy: false);
    }

    /// <summary>
    /// Parse an array of envelope entries (<c>[{code, source?}, ...]</c>).
    /// Used by both <c>errors[]</c> and <c>warnings[]</c> in expected-errors.json.
    /// <paramref name="fieldName"/> is the parent property name, used purely for
    /// error messages.
    /// </summary>
    private static IReadOnlyList<ExpectedError> ParseEnvelopeEntryArray(
        JsonElement arrEl, string fieldName)
    {
        var entries = new List<ExpectedError>();
        int idx = 0;
        foreach (var item in arrEl.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException(
                    $"expected-errors.json {fieldName}[{idx}] is not an object");
            if (!item.TryGetProperty("code", out var codeProp) ||
                codeProp.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException(
                    $"expected-errors.json {fieldName}[{idx}] missing string 'code' field");
            ExpectedErrorSource? source = null;
            if (item.TryGetProperty("source", out var srcEl) &&
                srcEl.ValueKind == JsonValueKind.Object)
            {
                if (!srcEl.TryGetProperty("format", out var fmtEl) ||
                    fmtEl.ValueKind != JsonValueKind.String)
                    throw new InvalidOperationException(
                        $"expected-errors.json {fieldName}[{idx}]: 'source.format' must be a string");
                if (!srcEl.TryGetProperty("files", out var filesEl) ||
                    filesEl.ValueKind != JsonValueKind.Array)
                    throw new InvalidOperationException(
                        $"expected-errors.json {fieldName}[{idx}]: 'source.files' must be a string[]");
                var files = filesEl.EnumerateArray()
                    .Select(f => f.ValueKind == JsonValueKind.String
                        ? f.GetString()!
                        : throw new InvalidOperationException(
                            $"expected-errors.json {fieldName}[{idx}]: 'source.files' contains non-string"))
                    .ToList();
                string? jsonPath = null;
                if (srcEl.TryGetProperty("jsonPath", out var jpEl) &&
                    jpEl.ValueKind == JsonValueKind.String)
                {
                    jsonPath = jpEl.GetString();
                }
                string? referrer = null;
                if (srcEl.TryGetProperty("referrer", out var refEl) &&
                    refEl.ValueKind == JsonValueKind.String)
                {
                    referrer = refEl.GetString();
                }
                string? target = null;
                if (srcEl.TryGetProperty("target", out var tgtEl) &&
                    tgtEl.ValueKind == JsonValueKind.String)
                {
                    target = tgtEl.GetString();
                }
                // FR5d — format=resolved requires both referrer and target.
                var fmt = fmtEl.GetString()!;
                if (fmt == "resolved")
                {
                    if (referrer is null)
                        throw new InvalidOperationException(
                            $"expected-errors.json {fieldName}[{idx}]: 'source.referrer' is required when format='resolved'");
                    if (target is null)
                        throw new InvalidOperationException(
                            $"expected-errors.json {fieldName}[{idx}]: 'source.target' is required when format='resolved'");
                }
                source = new ExpectedErrorSource(fmt, files, jsonPath, referrer, target);
            }
            entries.Add(new ExpectedError(codeProp.GetString()!, source));
            idx++;
        }
        return entries;
    }

    /// <summary>
    /// Backward-compat helper: returns just the error codes from either shape.
    /// Used by call sites that only care about the code-set.
    /// </summary>
    public static IReadOnlyList<string> ParseExpectedErrors(JsonElement root)
    {
        return ParseExpectedErrorsEnvelope(root).Errors.Select(e => e.Code).ToList();
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
