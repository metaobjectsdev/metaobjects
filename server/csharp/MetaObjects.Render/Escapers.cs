// Format-driven escaping (FR-004 R7/R8). The render engine OWNS escaping (it does
// not rely on the Mustache lib's HTML-only default), so behavior is identical
// across language ports. `{{var}}` is escaped per format; `{{{var}}}` is raw.
//
// RenderFormat values are kept independent of the metadata package's
// TEMPLATE_FORMATS to keep this engine a zero-core-dependency module. The two
// sets are kept in lock-step by the render-conformance corpus.
//
// Ported from typescript/packages/render/src/escapers.ts.

using System.Text;

namespace MetaObjects.Render;

/// <summary>Format-keyed escaper registry. Engine-owned; identical across ports.</summary>
public static class Escapers
{
    public const string FORMAT_TEXT        = "text";
    public const string FORMAT_HTML        = "html";
    public const string FORMAT_XML         = "xml";
    public const string FORMAT_CSV         = "csv";
    public const string FORMAT_JSON        = "json";
    public const string FORMAT_MARKDOWN    = "markdown";
    public const string FORMAT_SPREADSHEET = "spreadsheet";

    private static string Raw(string s) => s;

    private static string Xml(string s) =>
        s.Replace("&", "&amp;")
         .Replace("<", "&lt;")
         .Replace(">", "&gt;")
         .Replace("\"", "&quot;")
         .Replace("'", "&#39;");

    // OWASP CSV/Excel formula-injection guard: neutralize a leading active char.
    private static string InjectionGuard(string s) =>
        s.Length > 0 && "=+-@\t\r".IndexOf(s[0]) >= 0 ? "'" + s : s;

    private static string Csv(string s)
    {
        var v = InjectionGuard(s);
        return v.IndexOfAny(['"', ',', '\n', '\r']) >= 0
            ? "\"" + v.Replace("\"", "\"\"") + "\""
            : v;
    }

    // Mirrors JS JSON.stringify(s).slice(1, -1): escape ", \, and control chars;
    // nothing else (no HTML-safety escaping of < > &).
    private static string Json(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
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
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    private static readonly Dictionary<string, Func<string, string>> Registry = new(StringComparer.Ordinal)
    {
        [FORMAT_TEXT]     = Raw,
        [FORMAT_MARKDOWN] = Raw,
        [FORMAT_HTML]     = Xml,
        [FORMAT_XML]      = Xml,
        [FORMAT_JSON]     = Json,
        [FORMAT_CSV]      = Csv,
        // XML-escape the content first, then guard — so the guard's leading quote is a
        // literal apostrophe in the XML (which is what tells Excel "treat as text"),
        // not itself escaped to &#39;.
        [FORMAT_SPREADSHEET] = s => InjectionGuard(Xml(s)),
    };

    /// <summary>
    /// The escaper for a format. Unknown formats throw (callers pass a value from
    /// the closed TEMPLATE_FORMATS set). Defaults are not silently applied here —
    /// the Renderer applies "text" when no format is given.
    /// </summary>
    public static Func<string, string> For(string format) =>
        Registry.TryGetValue(format, out var fn)
            ? fn
            : throw new ArgumentException($"unknown render format \"{format}\"", nameof(format));
}
