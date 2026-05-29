using System.Text.RegularExpressions;

namespace MetaObjects.Render.Recover;

/// <summary>
/// Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.
/// </summary>
public sealed class XmlForgivingReader
{
    /// <summary>
    /// Parses <paramref name="span"/> as a forgiving XML document, returning
    /// the direct children of the root element as a dictionary keyed by tag name
    /// (lower-cased when <paramref name="caseInsensitive"/> is <c>true</c>).
    /// Values are <c>string</c> for text-only children, a nested
    /// <see cref="Dictionary{String, Object}"/> for element children, or a
    /// <see cref="List{Object}"/> when the same tag name appears more than once.
    /// Returns an empty dictionary for <c>null</c>, blank, or unrecoverable input.
    /// Never throws.
    /// </summary>
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
        var openTag = new Regex(
            @"<([A-Za-z_][A-Za-z0-9_]*)(\s[^>]*)?>",
            ci ? RegexOptions.IgnoreCase : RegexOptions.None);

        int pos = 0;
        Match m = openTag.Match(inner, pos);
        while (m.Success)
        {
            string tag = m.Groups[1].Value;
            string key = ci ? tag.ToLowerInvariant() : tag;
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
                // unclosed tag: recover text up to the next sibling open tag
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
            object? value = content.Contains('<')
                ? NestedOrText(content, ci)
                : content.Trim();

            Accumulate(out_, key, value);
            pos = next;
            if (pos >= inner.Length) break;
            m = openTag.Match(inner, pos);
        }
    }

    private static object? NestedOrText(string content, bool ci)
    {
        var nested = new Dictionary<string, object?>();
        ParseChildren(content, ci, nested);
        return nested.Count == 0 ? content.Trim() : (object?)nested;
    }

    private static void Accumulate(Dictionary<string, object?> out_, string key, object? value)
    {
        if (!out_.ContainsKey(key))
        {
            out_[key] = value;
            return;
        }
        object? existing = out_[key];
        if (existing is List<object?> list)
        {
            list.Add(value);
        }
        else
        {
            var newList = new List<object?> { existing, value };
            out_[key] = newList;
        }
    }
}
