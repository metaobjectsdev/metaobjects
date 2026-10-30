// One Mustache tag scanner shared by Verify and the renderer's partial expansion.
//
// Both used to find tags on their own (Verify with a "{{" search, Renderer with a
// "{{> x}}" regex), and neither knew what the engine knows: a comment ends at the
// first closing delimiter, "{{=<% %>=}}" changes the delimiters, and a section close
// must name the section it closes. Scan follows the Mustache spec for all three, so the
// two callers cannot disagree about where a tag is. Mirrors Mustache.parse in the
// TypeScript port and the Java and Python scanners.

namespace MetaObjects.Render;

/// <summary>One tag: its kind, trimmed name, and <c>[Start, End)</c> span in the text.</summary>
internal sealed record MustacheTag(MustacheTagKind Kind, string Value, int Start, int End);

internal enum MustacheTagKind { Name, Triple, Amp, Section, Inverted, Close, Partial, Comment, Delimiters }

/// <summary>An unbalanced section; <see cref="Section"/> is the section the finding is about.</summary>
internal sealed class MustacheSyntaxException(string message, string section) : Exception(message)
{
    public string Section { get; } = section;
}

internal static class MustacheTags
{
    private const string DefaultOpen = "{{";
    private const string DefaultClose = "}}";

    /// <summary>
    /// Every tag in <paramref name="text"/>, in order, honouring comments and delimiter changes.
    /// Throws <see cref="MustacheSyntaxException"/> for a close with no open, a close naming a
    /// different section than the one open, or a section never closed. An unterminated tag ends
    /// the scan (the rest is text), as it always did here.
    /// </summary>
    public static List<MustacheTag> Scan(string text)
    {
        var tags = new List<MustacheTag>();
        string open = DefaultOpen, close = DefaultClose;
        var openSections = new Stack<string>();
        int pos = 0;
        while (pos < text.Length)
        {
            int start = text.IndexOf(open, pos, StringComparison.Ordinal);
            if (start < 0) break;
            int contentStart = start + open.Length;
            bool triple = contentStart < text.Length && text[contentStart] == '{';
            string endDelim = triple ? "}" + close : close;
            if (triple) contentStart++;
            int closeIdx = text.IndexOf(endDelim, contentStart, StringComparison.Ordinal);
            if (closeIdx < 0) break;
            string content = text[contentStart..closeIdx].Trim();
            int end = closeIdx + endDelim.Length;
            pos = end;

            if (triple) { tags.Add(new(MustacheTagKind.Triple, content, start, end)); continue; }
            if (content.Length == 0) continue;
            char sigil = content[0];
            string name = content.Length > 1 ? content[1..].Trim() : "";
            switch (sigil)
            {
                case '!':
                    tags.Add(new(MustacheTagKind.Comment, name, start, end));
                    break;
                case '=':
                    if (content.Length > 1 && content.EndsWith('='))
                    {
                        var parts = content[1..^1].Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length == 2) { open = parts[0]; close = parts[1]; }
                    }
                    tags.Add(new(MustacheTagKind.Delimiters, name, start, end));
                    break;
                case '#':
                case '^':
                    openSections.Push(name);
                    tags.Add(new(sigil == '#' ? MustacheTagKind.Section : MustacheTagKind.Inverted, name, start, end));
                    break;
                case '/':
                    if (openSections.Count == 0)
                        throw new MustacheSyntaxException($"Unopened section \"{name}\"", name);
                    string opened = openSections.Pop();
                    if (opened != name)
                        throw new MustacheSyntaxException($"Unclosed section \"{opened}\"", opened);
                    tags.Add(new(MustacheTagKind.Close, name, start, end));
                    break;
                case '>':
                    tags.Add(new(MustacheTagKind.Partial, name, start, end));
                    break;
                case '&':
                    tags.Add(new(MustacheTagKind.Amp, name, start, end));
                    break;
                default:
                    tags.Add(new(MustacheTagKind.Name, content, start, end));
                    break;
            }
        }
        if (openSections.Count > 0)
        {
            string opened = openSections.Peek();
            throw new MustacheSyntaxException($"Unclosed section \"{opened}\"", opened);
        }
        return tags;
    }

    /// <summary>Where a text that changes delimiters cannot render, or <c>null</c> when it can:
    /// inlined text is parsed under the surrounding delimiters. A partial body
    /// (<paramref name="inlinedAs"/> is its ref) that changes them is reported at that ref; a text
    /// that changes them and inlines a partial is reported at its first partial.</summary>
    public static string? DelimiterConflict(IReadOnlyList<MustacheTag> tags, string? inlinedAs) =>
        !tags.Any(t => t.Kind == MustacheTagKind.Delimiters)
            ? null
            : inlinedAs ?? tags.FirstOrDefault(t => t.Kind == MustacheTagKind.Partial)?.Value;

    /// <summary><paramref name="text"/> with every comment cut out: what a tag-presence check may scan.</summary>
    public static string WithoutComments(string text, IReadOnlyList<MustacheTag> tags)
    {
        var sb = new System.Text.StringBuilder();
        int pos = 0;
        foreach (var tag in tags.Where(t => t.Kind == MustacheTagKind.Comment))
        {
            sb.Append(text, pos, tag.Start - pos);
            pos = tag.End;
        }
        return sb.Append(text, pos, text.Length - pos).ToString();
    }
}
