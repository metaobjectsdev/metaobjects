// Normalization — coerce a DB row's typed values into the canonical wire shape
// described in fixtures/persistence-conformance/normalization.md.
//
// Every per-port runner produces the same JSON for the same DB row, so a
// scenario's `expect:` block can be authored once and validated everywhere.

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MetaObjects.IntegrationTests.Runner;

public static class Normalization
{
    /// <summary>Normalize one row: each cell's value runs through <see cref="NormalizeValue"/>.</summary>
    public static IReadOnlyDictionary<string, object?> NormalizeRow(IReadOnlyDictionary<string, object?> row)
    {
        var result = new Dictionary<string, object?>(row.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in row) result[k] = NormalizeValue(v);
        return result;
    }

    /// <summary>
    /// Coerce a value to the canonical JSON-ready form. Strings/booleans/ints stay
    /// as is; BIGINT and NUMERIC become canonical strings; date/time types become
    /// the documented ISO strings; UUID becomes lowercase; enums (CLR-side) become
    /// their string name (matching EF Core's <c>.HasConversion&lt;string&gt;()</c>);
    /// JSON values are re-serialized with sorted keys; bytes become base64.
    /// </summary>
    public static object? NormalizeValue(object? v) => v switch
    {
        null => null,
        bool b => b,
        // Integer kinds — INT2/INT4 stay as JSON numbers; INT8 widens to a string
        // (JS Number loses precision above 2^53; the contract pins string form).
        long l => l.ToString(CultureInfo.InvariantCulture),
        int i => i,
        short s => (int)s,
        // Floating
        float f => (double)f,
        double d => d,
        // NUMERIC / DECIMAL — canonical decimal string, no trailing zeros.
        decimal dec => CanonicalDecimal(dec),
        // Strings already canonical.
        string str => str,
        // Date/time discriminated by source CLR type.
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TimeOnly time => time.ToString("HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        DateTime dt => FormatDateTime(dt),
        DateTimeOffset dto => dto.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffK", CultureInfo.InvariantCulture)
                                            .TrimEnd('0').TrimEnd('.') + "Z",
        Guid uuid => uuid.ToString("D").ToLowerInvariant(),
        // JSON arrives from Npgsql as string for jsonb columns; canonicalize.
        // (If a future driver returns a parsed JsonNode/JsonElement, the JsonNode
        // branch picks it up.)
        byte[] bytes => Convert.ToBase64String(bytes),
        JsonNode node => SortKeys(node).ToJsonString(),
        // Enums — both EF Core HasConversion<string>() (which reads as string) and
        // a raw enum value need to surface as the symbol name.
        Enum e => e.ToString(),
        _ => v.ToString(),
    };

    private static string CanonicalDecimal(decimal d)
    {
        // Trim trailing zeros from the fractional part; drop the decimal point if integral.
        var s = d.ToString(CultureInfo.InvariantCulture);
        if (!s.Contains('.')) return s;
        s = s.TrimEnd('0');
        if (s.EndsWith('.')) s = s[..^1];
        return s;
    }

    // TIMESTAMP (no TZ) → "YYYY-MM-DDTHH:MM:SS[.fff]" with no trailing zeros and no Z.
    // TIMESTAMPTZ comes via DateTimeOffset above and gets a Z; the bare DateTime
    // branch never appends one.
    private static string FormatDateTime(DateTime dt)
    {
        var withSubseconds = dt.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", CultureInfo.InvariantCulture);
        // Trim trailing zeros in the subsecond fraction, then trim the decimal point
        // if the subsecond portion was entirely zero.
        var s = withSubseconds.TrimEnd('0');
        if (s.EndsWith('.')) s = s[..^1];
        return s;
    }

    /// <summary>
    /// Build a new tree with sorted keys. DeepClone before reparenting —
    /// System.Text.Json forbids attaching a node that already has a parent.
    /// </summary>
    public static JsonNode SortKeys(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            var sorted = new JsonObject();
            foreach (var (k, v) in obj.OrderBy(p => p.Key, StringComparer.Ordinal))
                sorted[k] = v is null ? null : SortKeys(v.DeepClone());
            return sorted;
        }
        if (node is JsonArray arr)
        {
            var copy = new JsonArray();
            foreach (var item in arr) copy.Add(item is null ? null : SortKeys(item.DeepClone()));
            return copy;
        }
        return node.DeepClone();
    }

    /// <summary>
    /// Canonical-JSON serialization of an arbitrary node: object keys sorted
    /// recursively so two semantically-equal trees compare byte-equal.
    /// <c>null</c> serializes as the JSON literal <c>"null"</c>.
    /// </summary>
    public static string CanonicalJson(JsonNode? node) =>
        node is null
            ? "null"
            : JsonSerializer.Serialize(SortKeys(node), new JsonSerializerOptions { WriteIndented = false });

    /// <summary>
    /// Canonical JSON for a list of DB rows: each row normalized via
    /// <see cref="NormalizeRow"/>, top-level array preserved, all object keys sorted.
    /// </summary>
    public static string CanonicalRowsJson(IEnumerable<IReadOnlyDictionary<string, object?>> rows)
    {
        var arr = new JsonArray();
        foreach (var row in rows)
        {
            var obj = new JsonObject();
            foreach (var (k, v) in NormalizeRow(row))
                obj[k] = v is null ? null : JsonValue.Create(v);
            arr.Add(obj);
        }
        return CanonicalJson(arr);
    }
}
