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
        // REAL/DOUBLE → canonical plain-decimal string (format from the native type).
        float f => CanonicalFloat((double)f),
        double d => CanonicalFloat(d),
        // NUMERIC / DECIMAL — canonical decimal string, no trailing zeros.
        decimal dec => CanonicalDecimal(dec),
        // A @dbColumnType:jsonb open-bag is surfaced by the runtime as a PARSED JSON
        // value — System.Text.Json.JsonDocument/JsonElement (issue #98) — not raw text.
        // Route its raw JSON through the same jsonb path (sorted keys, leaf normalization)
        // so the wire form is byte-identical to a string-typed jsonb read across ports.
        JsonDocument doc => NormalizeValue(doc.RootElement.GetRawText()),
        JsonElement el => NormalizeValue(el.GetRawText()),
        // A jsonb/json value that reaches here as raw text (an owned-POCO jsonb field
        // projected to a JSON string by EntityRow, or a driver returning text) — re-serialize
        // with sorted keys per the cross-port contract (normalization.md: JSON/JSONB → sorted
        // keys), recursing through containers and normalizing each scalar leaf by its
        // JSON type. Leaves keep their JSON-native shape (matching the TS authority,
        // whose parsed-jsonb leaves stay JS numbers/booleans): integer numbers stay
        // JSON numbers, non-integer numbers become canonical plain-decimal strings,
        // strings/bools/null pass through. A plain text value that does not parse as a
        // JSON object/array stays a string.
        string js when TryParseJsonContainer(js, out var node) => NormalizeJsonContainer(node!),
        // Strings already canonical.
        string str => str,
        // Date/time discriminated by source CLR type.
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TimeOnly time => FormatTimeOnly(time),
        DateTime dt => FormatDateTime(dt),
        DateTimeOffset dto => dto.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffK", CultureInfo.InvariantCulture)
                                            .TrimEnd('0').TrimEnd('.') + "Z",
        Guid uuid => uuid.ToString("D").ToLowerInvariant(),
        byte[] bytes => Convert.ToBase64String(bytes),
        // A pre-parsed JsonNode (assembled by a runner path) — sort keys.
        // (JsonDocument/JsonElement from a @dbColumnType:jsonb column are handled above.)
        JsonNode node => SortKeys(node).ToJsonString(),
        // Enums — both EF Core HasConversion<string>() (which reads as string) and
        // a raw enum value need to surface as the symbol name.
        Enum e => e.ToString(),
        _ => v.ToString(),
    };

    /// <summary>
    /// Wrap a normalized cell value as a <see cref="JsonNode"/> for assembly into a
    /// row object. A value that is already a <see cref="JsonNode"/> (a normalized
    /// jsonb container) is taken as-is; null → null; everything else → a JsonValue.
    /// </summary>
    public static JsonNode? ToJsonValue(object? v) => v switch
    {
        null => null,
        JsonNode node => node,
        _ => JsonValue.Create(v),
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

    private static string CanonicalFloat(double d)
    {
        var s = d.ToString(CultureInfo.InvariantCulture);
        if (s.Contains('E') || s.Contains('e'))
            throw new FormatException(
                $"CanonicalFloat: {d} is outside the plain-decimal band (exponential notation); " +
                "REAL/DOUBLE fixture values must be in-band dyadic rationals — " +
                "see fixtures/persistence-conformance/normalization.md");
        if (!s.Contains('.')) return s;
        s = s.TrimEnd('0');
        if (s.EndsWith('.')) s = s[..^1];
        return s;
    }

    // TIMESTAMP vs TIMESTAMPTZ are BOTH surfaced by Npgsql/EF as `DateTime`; the
    // discriminator is DateTimeKind (Npgsql 6+/EF Core contract):
    //   * `timestamp with time zone`    → DateTimeKind.Utc, value already in UTC
    //                                      → "YYYY-MM-DDTHH:MM:SS[.fff]Z".
    //   * `timestamp` (no tz)            → DateTimeKind.Unspecified, wall-clock value
    //                                      → "YYYY-MM-DDTHH:MM:SS[.fff]" (no Z).
    // This mirrors the TS port's OID-keyed temporal parsers (canonicalTimestamptz
    // converts any offset to UTC + appends Z; canonicalTimestamp passes the wall
    // clock through with no Z) — see fixtures/persistence-conformance/normalization.md
    // and the TS temporal-parsers.ts. A non-UTC-seeded TIMESTAMPTZ thus reads back
    // as its UTC equivalent, proving normalization (not just formatting).
    private static string FormatDateTime(DateTime dt)
    {
        // Truncate (NOT round) sub-second to millisecond resolution — `fff` — to match
        // the other four ports' integer-division truncation (TS slice(dot+1,dot+4),
        // Java/Kotlin nanos/1_000_000, Python microsecond//1000). A 7-digit `fffffff`
        // here would surface `.123456` where every other port emits `.123`.
        var s = TrimSubseconds(dt.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture));
        return dt.Kind == DateTimeKind.Utc ? s + "Z" : s;
    }

    // TIME → "HH:MM:SS[.fff]" — truncated to millisecond resolution then trailing-zero
    // subseconds (and a bare decimal point) stripped, matching the other ports.
    private static string FormatTimeOnly(TimeOnly time) =>
        TrimSubseconds(time.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));

    // Strip trailing zeros from a subsecond fraction, then drop the decimal point
    // if the subsecond portion was entirely zero.
    private static string TrimSubseconds(string formatted)
    {
        if (!formatted.Contains('.')) return formatted;
        var s = formatted.TrimEnd('0');
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

    // True (with the parsed node) when `s` is a JSON object or array. A bare JSON
    // scalar (e.g. "42", "\"hi\"") is NOT treated as a container — an ordinary TEXT
    // column that happens to hold a number-looking string must stay a string.
    private static bool TryParseJsonContainer(string s, out JsonNode? node)
    {
        node = null;
        var t = s.TrimStart();
        if (t.Length == 0 || (t[0] != '{' && t[0] != '[')) return false;
        try { node = JsonNode.Parse(s); return node is JsonObject or JsonArray; }
        catch (JsonException) { return false; }
    }

    // Normalize a parsed jsonb container: sort object keys recursively and normalize
    // each scalar leaf by its JSON type, mirroring the TS authority's recursion over
    // parsed jsonb (normalizeValue): integer numbers stay JSON numbers, non-integer
    // numbers become canonical plain-decimal strings (no trailing zeros), and
    // strings/bools/null pass through unchanged. Object/array structure is preserved.
    private static JsonNode? NormalizeJsonContainer(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
                var o = new JsonObject();
                foreach (var (k, v) in obj.OrderBy(p => p.Key, StringComparer.Ordinal))
                    o[k] = v is null ? null : NormalizeJsonContainer(v.DeepClone());
                return o;
            case JsonArray arr:
                var a = new JsonArray();
                foreach (var item in arr) a.Add(item is null ? null : NormalizeJsonContainer(item.DeepClone()));
                return a;
            default:
                return NormalizeJsonLeaf(node);
        }
    }

    private static JsonNode? NormalizeJsonLeaf(JsonNode node) => node.GetValueKind() switch
    {
        JsonValueKind.String  => JsonValue.Create(node.GetValue<string>()),
        JsonValueKind.True    => JsonValue.Create(true),
        JsonValueKind.False   => JsonValue.Create(false),
        JsonValueKind.Null    => null,
        // Numbers: an integer-valued number stays a JSON number (INTEGER → number per
        // the contract); a non-integer becomes the canonical plain-decimal string.
        JsonValueKind.Number  => NormalizeJsonNumber(node),
        _                     => node.DeepClone(),
    };

    private static JsonNode NormalizeJsonNumber(JsonNode node)
    {
        var element = node.GetValue<System.Text.Json.JsonElement>();
        if (element.TryGetInt64(out var l)) return JsonValue.Create(l);
        return JsonValue.Create(CanonicalFloat(element.GetDouble()));
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
                obj[k] = ToJsonValue(v);
            arr.Add(obj);
        }
        return CanonicalJson(arr);
    }
}
