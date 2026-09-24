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
    // a closing tag. Used to spot a STRAY close (of an element whose open never appeared in
    // the body) — LLMs commonly end a block with the wrong tag.
    private const string CloseTagPattern = @"</([A-Za-z_][A-Za-z0-9_]*)\s*>";
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

        ParseChildren(inner, caseInsensitive, out_, null);
        return out_;
    }

    /// <summary>
    /// Rootless read: parse the WHOLE text's top-level elements directly, with no enclosing root
    /// element to strip (a flat sequence like <c>&lt;a&gt;..&lt;/a&gt;&lt;b&gt;..&lt;/b&gt;</c>).
    /// Used for rootless responses. Leading/trailing non-element text is ignored. Never throws.
    /// Mirrors Java XmlForgivingReader.readRootless.
    /// </summary>
    public Dictionary<string, object?> ReadRootless(string? text, bool caseInsensitive)
    {
        var out_ = new Dictionary<string, object?>();
        if (string.IsNullOrWhiteSpace(text)) return out_;
        ParseChildren(text!, caseInsensitive, out_, null);
        return out_;
    }

    /// <summary>
    /// Parse <paramref name="inner"/>'s elements into <paramref name="out_"/>. When
    /// <paramref name="loose"/> is non-null, the text BETWEEN those elements (an element's own
    /// text in mixed content) is appended to it, one segment per gap.
    /// </summary>
    private static void ParseChildren(string inner, bool ci, Dictionary<string, object?> out_, List<string>? loose)
    {
        var openTag = new Regex(OpenTagPattern, ci ? RegexOptions.IgnoreCase : RegexOptions.None);

        int pos = 0;
        Match m = openTag.Match(inner, pos);
        while (m.Success)
        {
            loose?.Add(inner.Substring(pos, m.Index - pos));

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
                // unclosed tag: extract content up to the next sibling open tag.
                Match sib = openTag.Match(inner, contentStart);
                if (sib.Success)
                {
                    // When the unclosed element's content begins IMMEDIATELY with a child
                    // open tag (no leading text), that child was almost certainly meant to
                    // be NESTED, not a sibling — a common LLM malformation is dropping the
                    // parent's close tag while still emitting a real child element
                    // (e.g. <check ...><payoff>text). Absorb the remainder of this span as
                    // the unclosed element's content so the child nests under it. When there
                    // IS leading text before the first child tag (e.g. <t>hi<c>..), keep the
                    // sibling split — the leading text is the unclosed element's body and the
                    // following tag is its sibling. Mirrors Java XmlForgivingReader.
                    bool noLeadingText = string.IsNullOrWhiteSpace(
                        inner.Substring(contentStart, sib.Index - contentStart));
                    if (noLeadingText)
                    {
                        contentEnd = inner.Length;
                        next = inner.Length;
                    }
                    else
                    {
                        contentEnd = sib.Index;
                        next = contentEnd;
                    }
                }
                else
                {
                    contentEnd = inner.Length;
                    next = inner.Length;
                }
                // A STRAY close tag of another element inside the unclosed element's body ends
                // the body there (the model closed the block with the wrong tag), and the stray
                // tag itself is dropped rather than kept as literal text.
                (int Start, int End)? stray = FindStrayClose(inner, contentStart, contentEnd, ci);
                if (stray is { } s)
                {
                    contentEnd = s.Start;
                    next = s.End;
                }
            }

            string content = inner.Substring(contentStart, contentEnd - contentStart);
            Accumulate(out_, key, Combine(attrs, content, ci));
            pos = next;
            if (pos >= inner.Length) break;
            m = openTag.Match(inner, pos);
        }
        loose?.Add(inner.Substring(pos));
    }

    /// <summary>
    /// The first close tag in <paramref name="inner"/>[from, to) whose element was never opened
    /// after <paramref name="from"/> — a stray close — as (start, end), or null. A close whose
    /// open DID appear is a nested child's own close, not stray.
    /// </summary>
    private static (int Start, int End)? FindStrayClose(string inner, int from, int to, bool ci)
    {
        var flags = ci ? RegexOptions.IgnoreCase : RegexOptions.None;
        string scope = inner.Substring(0, to);
        var closeRegex = new Regex(CloseTagPattern, flags);
        Match close = closeRegex.Match(scope, from);
        while (close.Success)
        {
            var openRegex = new Regex("<" + Regex.Escape(close.Groups[1].Value) + "(?=[\\s/>])", flags);
            if (!openRegex.IsMatch(inner.Substring(from, close.Index - from)))
            {
                return (close.Index, close.Index + close.Length);
            }
            close = closeRegex.Match(scope, close.Index + close.Length);
        }
        return null;
    }

    /// <summary>
    /// Combine an element's attributes with its body (nested children or plain text). Mixed
    /// content keeps BOTH: the children, and the element's own text under <see cref="TextKey"/>,
    /// so a scalar or @xmlText consumer still reads the prose around a child element.
    /// </summary>
    private static object? Combine(Dictionary<string, object?> attrs, string content, bool ci)
    {
        if (content.Contains('<'))
        {
            var nested = new Dictionary<string, object?>();
            var loose = new List<string>();
            ParseChildren(content, ci, nested, loose);
            if (nested.Count > 0)
            {
                // attributes first; a child element wins a name collision
                var merged = new Dictionary<string, object?>(attrs);
                foreach (var kv in nested) merged[kv.Key] = kv.Value;
                string text = MixedText(loose, ci);
                if (text.Length > 0) merged[TextKey] = text;
                return merged;
            }
        }
        return TextValue(attrs, content);
    }

    /// <summary>The text segments between child elements: stray close tags dropped, each
    /// trimmed, the non-empty ones joined with a single space.</summary>
    private static string MixedText(List<string> segments, bool ci)
    {
        var closeRegex = new Regex(CloseTagPattern, ci ? RegexOptions.IgnoreCase : RegexOptions.None);
        var parts = new List<string>();
        foreach (string seg in segments)
        {
            string t = closeRegex.Replace(seg, "").Trim();
            if (t.Length > 0) parts.Add(t);
        }
        return string.Join(" ", parts);
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
