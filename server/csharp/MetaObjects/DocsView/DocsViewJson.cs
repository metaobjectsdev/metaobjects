// JSON text exactly as JavaScript's JSON.stringify writes it, which is what the docs view contract
// states its bytes in (docs/features/docs-view.md): Pretty is JSON.stringify(v, null, 2), Compact
// is JSON.stringify(v).
//
// System.Text.Json's writer differs where byte parity matters: it escapes some characters
// JSON.stringify leaves alone and writes numbers in .NET's form. This writer escapes only what
// JSON.stringify escapes (the quote, the backslash, control characters and lone surrogates) and
// writes a number as a JavaScript Number prints. Mirrors the Java port's DocsViewJson.

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MetaObjects;

/// <summary>JSON text as JavaScript's <c>JSON.stringify</c> writes it.</summary>
public static class DocsViewJson
{
    /// <summary>Two-space indented JSON, as <c>JSON.stringify(v, null, 2)</c>.</summary>
    public static string Pretty(JsonNode? value)
    {
        var sb = new StringBuilder();
        Write(sb, value, "", pretty: true);
        return sb.ToString();
    }

    /// <summary>JSON with no whitespace, as <c>JSON.stringify(v)</c>.</summary>
    public static string Compact(JsonNode? value)
    {
        var sb = new StringBuilder();
        Write(sb, value, "", pretty: false);
        return sb.ToString();
    }

    /// <summary>A string as a JSON string literal, as <c>JSON.stringify(s)</c>.</summary>
    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        WriteString(sb, s);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsonNode? value, string indent, bool pretty)
    {
        switch (value)
        {
            case null:
                sb.Append("null");
                return;
            case JsonObject obj:
            {
                if (obj.Count == 0) { sb.Append("{}"); return; }
                string inner = indent + "  ";
                sb.Append('{');
                bool first = true;
                foreach (var (k, v) in obj)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    if (pretty) sb.Append('\n').Append(inner);
                    WriteString(sb, k);
                    sb.Append(pretty ? ": " : ":");
                    Write(sb, v, inner, pretty);
                }
                if (pretty) sb.Append('\n').Append(indent);
                sb.Append('}');
                return;
            }
            case JsonArray arr:
            {
                if (arr.Count == 0) { sb.Append("[]"); return; }
                string inner = indent + "  ";
                sb.Append('[');
                for (int i = 0; i < arr.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    if (pretty) sb.Append('\n').Append(inner);
                    Write(sb, arr[i], inner, pretty);
                }
                if (pretty) sb.Append('\n').Append(indent);
                sb.Append(']');
                return;
            }
            case JsonValue v:
                switch (v.GetValueKind())
                {
                    case JsonValueKind.String: WriteString(sb, v.GetValue<string>()); return;
                    case JsonValueKind.True: sb.Append("true"); return;
                    case JsonValueKind.False: sb.Append("false"); return;
                    case JsonValueKind.Null: sb.Append("null"); return;
                    case JsonValueKind.Number:
                        if (v.TryGetValue<long>(out long l)) sb.Append(Number(l));
                        else if (v.TryGetValue<int>(out int i)) sb.Append(Number(i));
                        else sb.Append(Number(v.GetValue<double>()));
                        return;
                    default:
                        sb.Append(v.ToJsonString());
                        return;
                }
        }
    }

    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) UnicodeEscape(sb, c);
                    else if (char.IsHighSurrogate(c))
                    {
                        if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) sb.Append(c).Append(s[++i]);
                        else UnicodeEscape(sb, c);
                    }
                    else if (char.IsLowSurrogate(c)) UnicodeEscape(sb, c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    private static void UnicodeEscape(StringBuilder sb, char c) =>
        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));

    /// <summary>An integer as a JavaScript <c>Number</c> prints it: exact up to 2^53, else the nearest double.</summary>
    public static string Number(long v) =>
        Math.Abs(v) <= (1L << 53) ? v.ToString(CultureInfo.InvariantCulture) : Number((double)v);

    /// <summary>A number as JavaScript's <c>Number.prototype.toString</c> writes it.</summary>
    public static string Number(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        if (d == 0) return "0";
        // "R" gives the shortest digits that round-trip (.NET Core 3.0+), as JavaScript does.
        string r = Math.Abs(d).ToString("R", CultureInfo.InvariantCulture);
        int exp = 0;
        int ePos = r.IndexOfAny(['E', 'e']);
        if (ePos >= 0)
        {
            exp = int.Parse(r[(ePos + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            r = r[..ePos];
        }
        int dot = r.IndexOf('.');
        string intPart = dot < 0 ? r : r[..dot];
        string fracPart = dot < 0 ? "" : r[(dot + 1)..];
        string all = intPart + fracPart;
        // The decimal exponent n of ECMA-262 Number::toString: value = 0.digits x 10^n.
        int e = intPart.Length + exp;
        int lead = 0;
        while (lead < all.Length - 1 && all[lead] == '0') lead++;
        e -= lead;
        string digits = all[lead..].TrimEnd('0');
        if (digits.Length == 0) return "0";
        int k = digits.Length;
        var sb = new StringBuilder();
        if (d < 0) sb.Append('-');
        if (k <= e && e <= 21)
        {
            sb.Append(digits).Append('0', e - k);
        }
        else if (0 < e && e <= 21)
        {
            sb.Append(digits, 0, e).Append('.').Append(digits, e, k - e);
        }
        else if (-6 < e && e <= 0)
        {
            sb.Append("0.").Append('0', -e).Append(digits);
        }
        else
        {
            int x = e - 1;
            sb.Append(digits[0]);
            if (k > 1) sb.Append('.').Append(digits, 1, k - 1);
            sb.Append('e').Append(x < 0 ? '-' : '+').Append(Math.Abs(x).ToString(CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }
}
