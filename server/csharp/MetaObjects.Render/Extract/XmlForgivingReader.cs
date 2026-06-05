using System.Text.RegularExpressions;

namespace MetaObjects.Render.Extract;

/// <summary>
/// Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.
/// Mirrors Java XmlForgivingReader: maps an element's child elements, text, AND attributes
/// into the field map, and handles self-closing tags (<c>&lt;x a="1"/&gt;</c>).
///
/// <para>Representation: text-only element with no attributes → its trimmed text
/// (<c>string</c>); self-closing / attributes-only element → a dictionary of attribute
/// name→value (empty string when none); element with child elements (± attributes) → a
/// dictionary merging attributes and child entries (a child element wins a name collision);
/// element with text AND attributes → a dictionary of the attributes plus the body text under
/// <see cref="TextKey"/> (a scalar consumer unwraps it); repeated sibling tags → a list.</para>
/// </summary>
public sealed class XmlForgivingReader
{
    /// <summary>
    /// Reserved key holding an element's own text content when the element is represented as a
    /// dictionary (because it also carries attributes). '#' is not a legal XML name char, so it
    /// never collides with a real attribute or child-element name.
    /// </summary>
    public const string TextKey = "#text";

    // tag name + everything up to the closing '>' (attributes and/or a trailing '/' for a
    // self-closing tag). Non-greedy so the first '>' closes the open tag.
    private const string OpenTagPattern = @"<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>";
    // one attribute: name = "double" | 'single' | bareword.
    private static readonly Regex AttrRegex = new(
        "([A-Za-z_:][A-Za-z0-9_:.\\-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s/>]+))",
        RegexOptions.Compiled);

    public Dictionary<string, object?> Read(string? span, bool caseInsensitive)
    {
        var out_ = new Dictionary<string, object?>();
        if (string.IsNullOrWhiteSpace(span)) return out_;

        int gt = span.IndexOf('>');
        if (gt < 0) return out_;

        int rootEnd = span.LastIndexOf("</");
        int innerEnd = (rootEnd < 0 || rootEnd <= gt) ? span.Length : rootEnd;
        string inner = span.Substring(gt + 1, innerEnd - (gt + 1));

        ParseChildren(inner, caseInsensitive, out_);
        return out_;
    }

    private static void ParseChildren(string inner, bool ci, Dictionary<string, object?> out_)
    {
        var openTag = new Regex(OpenTagPattern, ci ? RegexOptions.IgnoreCase : RegexOptions.None);

        int pos = 0;
        Match m = openTag.Match(inner, pos);
        while (m.Success)
        {
            string tag = m.Groups[1].Value;
            string key = ci ? tag.ToLowerInvariant() : tag;

            string rawAttrs = m.Groups[2].Value.Trim();
            bool selfClosing = rawAttrs.EndsWith("/");
            if (selfClosing) rawAttrs = rawAttrs.Substring(0, rawAttrs.Length - 1).Trim();
            var attrs = ParseAttrs(rawAttrs, ci);

            if (selfClosing)
            {
                Accumulate(out_, key, attrs.Count == 0 ? (object?)"" : attrs);
                pos = m.Index + m.Length;
                if (pos >= inner.Length) break;
                m = openTag.Match(inner, pos);
                continue;
            }

            int contentStart = m.Index + m.Length;
            string closeRe = @"</" + Regex.Escape(tag) + @"\s*>";
            var closeRegex = new Regex(closeRe, ci ? RegexOptions.IgnoreCase : RegexOptions.None);
            Match close = closeRegex.Match(inner, contentStart);

            int contentEnd, next;
            if (close.Success)
            {
                contentEnd = close.Index;
                next = close.Index + close.Length;
            }
            else
            {
                // unclosed tag: extract text up to the next sibling open tag
                Match sib = openTag.Match(inner, contentStart);
                if (sib.Success)
                {
                    contentEnd = sib.Index;
                    next = contentEnd;
                }
                else
                {
                    contentEnd = inner.Length;
                    next = inner.Length;
                }
            }

            string content = inner.Substring(contentStart, contentEnd - contentStart);
            Accumulate(out_, key, Combine(attrs, content, ci));
            pos = next;
            if (pos >= inner.Length) break;
            m = openTag.Match(inner, pos);
        }
    }

    /// <summary>Combine an element's attributes with its body (nested children or plain text).</summary>
    private static object? Combine(Dictionary<string, object?> attrs, string content, bool ci)
    {
        if (content.Contains('<'))
        {
            var nested = new Dictionary<string, object?>();
            ParseChildren(content, ci, nested);
            if (nested.Count > 0)
            {
                // attributes first; a child element wins a name collision
                var merged = new Dictionary<string, object?>(attrs);
                foreach (var kv in nested) merged[kv.Key] = kv.Value;
                return merged;
            }
        }
        return TextValue(attrs, content);
    }

    private static object? TextValue(Dictionary<string, object?> attrs, string content)
    {
        string text = content.Trim();
        if (attrs.Count == 0) return text;
        var m = new Dictionary<string, object?>(attrs) { [TextKey] = text };
        return m;
    }

    private static Dictionary<string, object?> ParseAttrs(string rawAttrs, bool ci)
    {
        var attrs = new Dictionary<string, object?>();
        if (rawAttrs.Length == 0) return attrs;
        foreach (Match a in AttrRegex.Matches(rawAttrs))
        {
            string name = ci ? a.Groups[1].Value.ToLowerInvariant() : a.Groups[1].Value;
            string val = a.Groups[2].Success ? a.Groups[2].Value
                : a.Groups[3].Success ? a.Groups[3].Value
                : a.Groups[4].Success ? a.Groups[4].Value : "";
            if (!attrs.ContainsKey(name)) attrs[name] = val;
        }
        return attrs;
    }

    private static void Accumulate(Dictionary<string, object?> out_, string key, object? value)
    {
        if (!out_.ContainsKey(key))
        {
            out_[key] = value;
            return;
        }
        if (out_[key] is List<object?> list)
            list.Add(value);
        else
            out_[key] = new List<object?> { out_[key], value };
    }
}
