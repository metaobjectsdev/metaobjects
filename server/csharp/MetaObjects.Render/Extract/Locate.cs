using System.Text.RegularExpressions;

namespace MetaObjects.Render.Extract;

/// <summary>
/// Stages 2–3: isolate and select the payload root span.
/// JSON: the engine picks among JsonCandidates by the schema (fenced first, first object carrying a declared field); Json() (first-closed-else-first-open) is its fallback.
/// </summary>
public static class Locate
{
    /// <summary>
    /// Returns the first balanced <c>{...}</c> span in <paramref name="text"/>.
    /// If no balanced object exists, returns the span from the first <c>{</c> to the end.
    /// Returns <c>null</c> if no <c>{</c> is found. String-aware (braces inside JSON strings
    /// are not counted).
    /// </summary>
    public static string? Json(string? text)
    {
        if (text == null) return null;
        int firstOpen = -1;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] == '{')
            {
                if (firstOpen < 0) firstOpen = i;
                int end = ScanBalanced(text, i);
                if (end >= 0) return text[i..(end + 1)];
            }
        }
        return firstOpen < 0 ? null : text[firstOpen..];
    }

    /// <summary>
    /// Returns the index of the matching <c>}</c>, or -1 if unterminated. String-aware.
    /// </summary>
    /// <summary>
    /// Every top-level object span in <paramref name="text"/>, in order: each balanced {...}
    /// (nested objects are part of their parent, not separate spans), and, for a '{' that never
    /// closes, the text from it to the end.
    /// </summary>
    public static IReadOnlyList<string> JsonCandidates(string? text)
    {
        var output = new List<string>();
        if (text == null) return output;
        bool tailAdded = false;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] != '{') continue;
            int end = ScanBalanced(text, i);
            if (end >= 0)
            {
                output.Add(text.Substring(i, end - i + 1));
                i = end;
            }
            else if (!tailAdded)
            {
                output.Add(text[i..]);
                tailAdded = true;
            }
        }
        return output;
    }

    private static int ScanBalanced(string s, int open)
    {
        int depth = 0;
        bool inStr = false;
        bool esc = false;
        for (int i = open; i < s.Length; i++)
        {
            char c = s[i];
            if (inStr)
            {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
                continue;
            }
            // Comment-aware: a brace or quote inside `// good } really` must not close the
            // object early. Only after whitespace or a separator, so `http://x` is no comment.
            if (i > open && (char.IsWhiteSpace(s[i - 1]) || s[i - 1] is ',' or '{' or '['))
            {
                int end = JsonForgivingReader.CommentEnd(s, i);
                if (end >= 0) { i = end - 1; continue; }
            }
            if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}') { depth--; if (depth == 0) return i; }
        }
        return -1;
    }

    /// <summary>
    /// Returns the span of <c>&lt;rootName&gt;...&lt;/rootName&gt;</c> in <paramref name="text"/>.
    /// If the close tag is absent, returns from the opener to the end.
    /// Returns <c>null</c> if no opener is found.
    /// </summary>
    /// <param name="text">Input text to search.</param>
    /// <param name="rootName">XML element name to locate.</param>
    /// <param name="caseInsensitive">Whether the element name match should be case-insensitive.</param>
    public static string? Xml(string? text, string? rootName, bool caseInsensitive)
    {
        if (text == null || rootName == null) return null;
        var flags = caseInsensitive
            ? RegexOptions.IgnoreCase
            : RegexOptions.None;
        var openPattern = new Regex($"<{Regex.Escape(rootName)}(\\s[^>]*)?>", flags);
        var openMatch = openPattern.Match(text);
        if (!openMatch.Success) return null;
        int start = openMatch.Index;
        int gt = openMatch.Index + openMatch.Length - 1; // position of the '>' closing the open tag

        var closePattern = new Regex($"</{Regex.Escape(rootName)}\\s*>", flags);
        var closeMatch = closePattern.Match(text, openMatch.Index + openMatch.Length);
        // Guard: if close found but its end position <= gt, treat as no-close (shouldn't
        // normally occur, but protects against malformed input such as a bare close tag).
        if (closeMatch.Success && closeMatch.Index + closeMatch.Length > gt)
        {
            return text[start..(closeMatch.Index + closeMatch.Length)];
        }
        return text[start..];
    }
}
