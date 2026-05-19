// DataConverter — convert a raw JSON value to a valid AttrValue.
//
// Ported 1:1 from typescript/packages/metadata/src/data-converter.ts.
//
// AttrValue contract (locked):
//   C# stores attr values as object? constrained at runtime to exactly:
//     - string
//     - long   (all integers; never int)
//     - double (non-integer numbers)
//     - bool
//     - IReadOnlyList<string>
//   This single-path number model keeps the canonical serializer correct.
//   Callers that receive object? MUST test type before use; casting to int
//   or float is forbidden.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects;

/// <summary>
/// Convert a raw parsed JSON value to a valid AttrValue for a known DataType.
/// </summary>
/// <remarks>
/// Mirrors <c>data-converter.ts</c>: two exported functions, <c>convertToDataType</c>
/// (type-directed, used by the parser for declared attrs) and <c>toAttrValue</c>
/// (no known type, used for undeclared @ attrs).
/// </remarks>
public static class DataConverter
{
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /// <summary>
    /// Convert a raw JSON element to a valid AttrValue for a <em>known</em>
    /// <see cref="DataType"/>. Throws <see cref="FormatException"/> for values
    /// that cannot become a valid attr value (null, nested arrays, objects that
    /// cannot be stringified meaningfully). Arrays always return
    /// <see cref="IReadOnlyList{string}"/> regardless of the scalar DataType.
    /// </summary>
    /// <remarks>
    /// Mirrors TS <c>convertToDataType(dataType, raw)</c>.
    /// </remarks>
    public static object ToAttrValue(JsonElement element) =>
        ToAttrValueInternal(element, fnName: "toAttrValue", typeDirected: false, dataType: null);

    /// <summary>
    /// Convert a raw JSON element to a valid AttrValue, coercing toward the
    /// given <see cref="DataType"/>. For declared <c>@</c>-attrs whose type is
    /// known from the registered schema. Arrays always return
    /// <see cref="IReadOnlyList{string}"/> regardless of the scalar DataType;
    /// scalars are coerced (e.g. string "42" → long 42, string "true" → bool).
    /// </summary>
    /// <remarks>
    /// Mirrors TS <c>convertToDataType(dataType, raw)</c>.
    /// </remarks>
    public static object ConvertToDataType(DataType dataType, JsonElement element) =>
        ToAttrValueInternal(element, fnName: "convertToDataType", typeDirected: true, dataType: dataType);

    /// <summary>
    /// Convert an already-parsed attr value (i.e. <c>object?</c> from <see cref="MetaData.OwnAttr"/>)
    /// to the given <see cref="DataType"/>. Used by <c>MetaField.DefaultValue()</c> to re-coerce
    /// the <c>@default</c> attr that was already stored (analogous to TS
    /// <c>convertToDataType(dataType, raw)</c> where <c>raw</c> is an already-parsed value).
    /// </summary>
    public static object? ConvertToDataType(DataType dataType, object? raw)
    {
        if (raw is null) return null;

        // Array → IReadOnlyList<string> (passthrough — already converted at parse time).
        if (raw is IReadOnlyList<string> list) return list;

        // Type-directed coercion on scalar values.
        return dataType switch
        {
            DataType.Boolean => raw is bool b ? (object)b
                             : raw is string s && s == "true" ? true
                             : raw is string s2 && s2 == "false" ? false
                             : raw,
            DataType.Int or DataType.Long =>
                raw is long ? raw
                : raw is double d && d == Math.Floor(d) ? (object)(long)d
                : raw is string str && long.TryParse(str, out long parsed) ? parsed
                : raw,
            DataType.Double =>
                raw is double ? raw
                : raw is long lg ? (object)(double)lg
                : raw is string str2 && double.TryParse(str2,
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out double pd) ? pd
                : raw,
            // String, Object, Date — string form (mirrors TS `default: String(raw)`).
            _ => raw is string ? raw : raw.ToString() ?? raw,
        };
    }

    // -------------------------------------------------------------------------
    // Internal dispatch
    // -------------------------------------------------------------------------

    private static object ToAttrValueInternal(
        JsonElement element,
        string fnName,
        bool typeDirected,
        DataType? dataType)
    {
        // Reject null — mirrors rejectNullish in TS.
        if (element.ValueKind == JsonValueKind.Null || element.ValueKind == JsonValueKind.Undefined)
            throw new FormatException($"{fnName}: null is not a valid attr value");

        // Arrays → IReadOnlyList<string> always (regardless of scalar DataType).
        if (element.ValueKind == JsonValueKind.Array)
            return ToStringArray(element, fnName);

        if (!typeDirected)
        {
            // toAttrValue — no type-directed coercion; return the JSON scalar as-is.
            return element.ValueKind switch
            {
                JsonValueKind.String  => element.GetString()!,
                JsonValueKind.True    => (object)true,
                JsonValueKind.False   => (object)false,
                JsonValueKind.Number  => ParseNumber(element),
                _ => throw new FormatException(
                    $"toAttrValue: {element.ValueKind} is not a valid attr value"),
            };
        }

        // convertToDataType — type-directed coercion.
        return dataType! switch
        {
            DataType.Boolean => ToBoolean(element, fnName),
            DataType.Int     => ToInteger(element, fnName),
            DataType.Long    => ToInteger(element, fnName),
            DataType.Double  => ToDouble(element, fnName),
            // String, Object, Date — string form (mirrors TS `default: String(raw)`).
            _ => element.ValueKind == JsonValueKind.String
                    ? element.GetString()!
                    : element.GetRawText(),
        };
    }

    // -------------------------------------------------------------------------
    // Type coercions — each mirrors the matching TS helper
    // -------------------------------------------------------------------------

    /// <summary>
    /// Mirrors TS <c>toBoolean(raw)</c>:
    /// <list type="bullet">
    ///   <item>bool JSON → bool</item>
    ///   <item>string "true" → true, "false" → false</item>
    ///   <item>anything else → pass through as-is (leave for attr-schema validation)</item>
    /// </list>
    /// </summary>
    private static object ToBoolean(JsonElement element, string fnName)
    {
        if (element.ValueKind == JsonValueKind.True)  return true;
        if (element.ValueKind == JsonValueKind.False) return false;
        if (element.ValueKind == JsonValueKind.String)
        {
            string s = element.GetString()!;
            if (s == "true")  return true;
            if (s == "false") return false;
            // Not boolean-shaped — pass through as-is (TS does the same).
            return s;
        }
        // Non-boolean, non-string — pass through as raw text (best-effort, for attr-schema validation).
        return element.GetRawText();
    }

    /// <summary>
    /// Mirrors TS <c>toInteger(raw)</c>:
    /// <list type="bullet">
    ///   <item>integer JSON number → long (if in safe range)</item>
    ///   <item>unsafe-integer JSON number → string (verbatim, to preserve precision)</item>
    ///   <item>strict integer string (e.g. "42", "-7") → long (if safe)</item>
    ///   <item>float-notation whole-number string (e.g. "3.0") → long (if safe integer value)</item>
    ///   <item>anything else → pass through as-is</item>
    /// </list>
    /// </summary>
    private static object ToInteger(JsonElement element, string fnName)
    {
        // JS safe-integer range: [-(2^53 - 1), 2^53 - 1]
        const long JsSafeIntegerMax =  9007199254740991L;
        const long JsSafeIntegerMin = -9007199254740991L;

        if (element.ValueKind == JsonValueKind.Number)
        {
            if (element.TryGetInt64(out long lng))
                return lng;
            // Non-integer JSON number (e.g. 3.7) — pass through as double,
            // matching TS `toInteger` which returns `raw` (the number) unchanged.
            return element.GetDouble();
        }
        if (element.ValueKind == JsonValueKind.String)
        {
            string s = element.GetString()!;
            // Strict integer string (e.g. "42", "-7").
            if (Regex.IsMatch(s, @"^-?\d+$"))
            {
                if (long.TryParse(s, out long parsed))
                    return parsed;
                // Beyond range — keep verbatim.
                return s;
            }
            // Float-notation strings that represent a whole number (e.g. "3.0", "12.0").
            // Mirrors TS: convert only when Number.isSafeInteger(parsed) — values beyond
            // 2^53−1 would have already lost precision in the double; keep original string.
            if (double.TryParse(s, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out double parsed2)
                && double.IsFinite(parsed2)
                && parsed2 == Math.Floor(parsed2))
            {
                long asLong = (long)parsed2;
                if (asLong >= JsSafeIntegerMin && asLong <= JsSafeIntegerMax)
                    return asLong;
                // Outside safe-integer range — keep original string verbatim (mirrors TS).
                return s;
            }
            // Not integer-shaped — pass through.
            return s;
        }
        // Non-numeric — pass through as raw text.
        return element.GetRawText();
    }

    /// <summary>
    /// Mirrors TS <c>toDouble(raw)</c>:
    /// <list type="bullet">
    ///   <item>any JSON number → double</item>
    ///   <item>finite numeric string → double</item>
    ///   <item>anything else → pass through as-is</item>
    /// </list>
    /// </summary>
    private static object ToDouble(JsonElement element, string fnName)
    {
        if (element.ValueKind == JsonValueKind.Number)
        {
            return element.GetDouble();
        }
        if (element.ValueKind == JsonValueKind.String)
        {
            string s = element.GetString()!;
            if (s.Trim() != "" && double.TryParse(s, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out double parsed)
                && double.IsFinite(parsed))
            {
                return parsed;
            }
            return s;
        }
        return element.GetRawText();
    }

    /// <summary>
    /// Parse a JSON number element into <see cref="long"/> or <see cref="double"/>.
    /// Integers are always long; non-integers are double.
    /// </summary>
    private static object ParseNumber(JsonElement element)
    {
        if (element.TryGetInt64(out long lng))
            return lng;
        return element.GetDouble();
    }

    /// <summary>
    /// Mirrors TS <c>toStringArray(arr)</c>:
    /// every element is stringified; nested arrays and null elements throw.
    /// </summary>
    private static IReadOnlyList<string> ToStringArray(JsonElement element, string fnName)
    {
        var list = new List<string>(element.GetArrayLength());
        int i = 0;
        foreach (JsonElement el in element.EnumerateArray())
        {
            if (el.ValueKind == JsonValueKind.Array)
                throw new FormatException(
                    $"array element at index {i} is a nested array — not supported");
            if (el.ValueKind == JsonValueKind.Null || el.ValueKind == JsonValueKind.Undefined)
                throw new FormatException(
                    $"array element at index {i} is null/undefined");
            // String(el) equivalent: use the raw string value for strings, raw text otherwise.
            list.Add(el.ValueKind == JsonValueKind.String
                ? el.GetString()!
                : el.GetRawText());
            i++;
        }
        return list.AsReadOnly();
    }
}
