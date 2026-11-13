// With package namespaces on, a generated file sits in a namespace derived from a metadata package,
// so a package segment can shadow a framework namespace (`acme::app::system` derives `Acme.App.System`,
// and a bare `System.Text.Json` inside it resolves into that namespace: CS0234). The runner therefore
// spells every framework reference in a generated C# file `global::`-qualified.
//
// Only code is touched. The file is read with a small C# lexer, so line and block comments, regular,
// verbatim, interpolated and raw string literals and char literals are copied through unchanged; the
// holes of a regular or verbatim interpolated string are code and are qualified. A using, global using,
// namespace or preprocessor line is left alone.

using System.Text;

namespace MetaObjects.Codegen;

/// <summary>Qualifies <c>System.</c> / <c>Microsoft.</c> references in generated C# with <c>global::</c>.</summary>
public static class FrameworkQualifier
{
    /// <summary><paramref name="file"/> with its framework references qualified, when
    /// <paramref name="config"/> has package namespaces on and the file is C# source; else unchanged.</summary>
    public static EmittedFile Apply(GenConfig config, EmittedFile file)
    {
        if (!config.PackageNamespacesFromMetadata || !file.Path.EndsWith(".cs", StringComparison.Ordinal)) return file;
        return file with { Content = Qualify(file.Content) };
    }

    /// <summary>The lexer behind <see cref="Apply"/>, over a whole C# source text.</summary>
    public static string Qualify(string src)
    {
        var sb = new StringBuilder(src.Length + 256);
        var i = 0;
        Code(src, ref i, sb, inHole: false);
        return sb.ToString();
    }

    private static bool AtLineStart(string s, int i)
    {
        for (var k = i - 1; k >= 0 && s[k] != '\n'; k--)
            if (s[k] != ' ' && s[k] != '\t' && s[k] != '\r') return false;
        return true;
    }

    private static bool Word(char c) => char.IsLetterOrDigit(c) || c == '_';

    // Copies code from i; in a hole, returns at the closing brace that matches the hole's opening one.
    private static void Code(string s, ref int i, StringBuilder sb, bool inHole)
    {
        var depth = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (AtLineStart(s, i) && (UsingDirective(s, i) || Starts(s, i, "global using ") || Starts(s, i, "namespace ") || s[i] == '#') && !inHole)
            {
                var eol = s.IndexOf('\n', i);
                if (eol < 0) eol = s.Length;
                sb.Append(s, i, eol - i);
                i = eol;
                continue;
            }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/')
            {
                var eol = s.IndexOf('\n', i);
                if (eol < 0) eol = s.Length;
                sb.Append(s, i, eol - i);
                i = eol;
                continue;
            }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*')
            {
                var end = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
                end = end < 0 ? s.Length : end + 2;
                sb.Append(s, i, end - i);
                i = end;
                continue;
            }
            if (c == '\'')
            {
                var j = i + 1;
                while (j < s.Length && s[j] != '\'' && s[j] != '\n') j += s[j] == '\\' ? 2 : 1;
                j = Math.Min(j + 1, s.Length);
                sb.Append(s, i, j - i);
                i = j;
                continue;
            }
            if (c is '"' or '$' or '@' && StringStart(s, i, out var dollars, out var verbatim, out var quotes))
            {
                String(s, ref i, sb, dollars, verbatim, quotes);
                continue;
            }
            if (inHole)
            {
                if (c == '{') depth++;
                else if (c == '}')
                {
                    if (depth == 0) return;
                    depth--;
                }
            }
            if ((c == 'S' || c == 'M') && (i == 0 || !(Word(s[i - 1]) || s[i - 1] is '.' or ':' or '@'))
                && (Starts(s, i, "System.") || Starts(s, i, "Microsoft."))
                && i + (c == 'S' ? 7 : 10) < s.Length && char.IsUpper(s[i + (c == 'S' ? 7 : 10)]))
                sb.Append("global::");
            sb.Append(c);
            i++;
        }
    }

    private static bool Starts(string s, int i, string t) => string.CompareOrdinal(s, i, t, 0, t.Length) == 0;

    // True when a `using` at i is a directive; `using var x = ..` and `using (..)` are statements.
    private static bool UsingDirective(string s, int i)
    {
        if (!Starts(s, i, "using ")) return false;
        var j = i + 6;
        while (j < s.Length && (s[j] == ' ' || s[j] == '\t')) j++;
        if (j >= s.Length) return true;
        if (s[j] == '(') return false;
        return !(Starts(s, j, "var") && (j + 3 >= s.Length || !Word(s[j + 3])));
    }

    // A string literal opens here: a run of $ and @ then quotes, or a bare quote.
    private static bool StringStart(string s, int i, out int dollars, out bool verbatim, out int quotes)
    {
        dollars = 0; verbatim = false; quotes = 0;
        var j = i;
        while (j < s.Length && (s[j] == '$' || s[j] == '@'))
        {
            if (s[j] == '$') dollars++; else verbatim = true;
            j++;
        }
        if (j >= s.Length || s[j] != '"') return false;
        while (j + quotes < s.Length && s[j + quotes] == '"') quotes++;
        // `""` is an empty regular string, not the start of a raw one.
        if (quotes == 2) quotes = 1;
        return true;
    }

    private static void String(string s, ref int i, StringBuilder sb, int dollars, bool verbatim, int quotes)
    {
        while (s[i] != '"') sb.Append(s[i++]);
        if (quotes >= 3)
        {
            // Raw: ends at the same number of quotes; copied through whole (holes included).
            var close = new string('"', quotes);
            var end = s.IndexOf(close, i + quotes, StringComparison.Ordinal);
            end = end < 0 ? s.Length : end + quotes;
            sb.Append(s, i, end - i);
            i = end;
            return;
        }
        sb.Append('"');
        i++;
        while (i < s.Length)
        {
            var c = s[i];
            if (c == '"')
            {
                if (verbatim && i + 1 < s.Length && s[i + 1] == '"') { sb.Append("\"\""); i += 2; continue; }
                sb.Append('"');
                i++;
                return;
            }
            if (c == '\\' && !verbatim) { sb.Append(c); if (i + 1 < s.Length) sb.Append(s[i + 1]); i += 2; continue; }
            if (dollars > 0 && c == '{')
            {
                if (i + 1 < s.Length && s[i + 1] == '{') { sb.Append("{{"); i += 2; continue; }
                sb.Append('{');
                i++;
                Code(s, ref i, sb, inHole: true);
                if (i < s.Length) { sb.Append('}'); i++; }
                continue;
            }
            sb.Append(c);
            i++;
        }
    }
}
