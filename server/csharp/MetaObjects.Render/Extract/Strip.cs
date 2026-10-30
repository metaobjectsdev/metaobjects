using System.Text.RegularExpressions;

namespace MetaObjects.Render.Extract;

/// <summary>
/// Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate.
/// </summary>
public static class Strip
{
    // An opening fence: a run of 3+ backticks, an optional language tag (json/xml/etc, dropped), a line end.
    private static readonly Regex Open = new(
        @"(`{3,})[a-zA-Z0-9_\-]*\s*\r?\n",
        RegexOptions.Compiled);

    private readonly record struct Fence(int Start, int End, string Body);

    /// <summary>
    /// Every fenced block, in order. A fence closes at a line that starts with a backtick run at
    /// least as long as the opening one and carries nothing else, so backticks inside the payload
    /// (a JSON string holding `make` or a nested code sample) do not truncate it. A reply that
    /// closes on the payload's own line is accepted when that run ends the text.
    /// </summary>
    private static List<Fence> Fences(string raw)
    {
        var output = new List<Fence>();
        int pos = 0;
        while (pos <= raw.Length)
        {
            var m = Open.Match(raw, pos);
            if (!m.Success) break;
            int bodyStart = m.Index + m.Length;
            var close = FindClose(raw, bodyStart, m.Groups[1].Length);
            if (close is not var (bodyEnd, end))
            {
                pos = bodyStart;
                continue;
            }
            output.Add(new Fence(m.Index, end, raw[bodyStart..bodyEnd]));
            pos = end;
        }
        return output;
    }

    private static (int BodyEnd, int End)? FindClose(string raw, int from, int width)
    {
        for (int ls = from; ls <= raw.Length;)
        {
            int i = ls;
            while (i < raw.Length && (raw[i] == ' ' || raw[i] == '\t') && i - ls < 4) i++;
            int j = i;
            while (j < raw.Length && raw[j] == '`') j++;
            if (j - i >= width)
            {
                int k = j;
                while (k < raw.Length && (raw[k] == ' ' || raw[k] == '\t')) k++;
                if (k >= raw.Length || raw[k] == '\n' || raw[k] == '\r') return (BodyEnd(raw, from, ls), j);
            }
            int nl = raw.IndexOf('\n', ls);
            if (nl < 0) break;
            ls = nl + 1;
        }
        // No closing line: accept a final backtick run that ends the text on the payload's own line.
        int tail = raw.TrimEnd().Length;
        int t = tail;
        while (t > from && raw[t - 1] == '`') t--;
        return tail - t >= width && t > from ? (t, tail) : null;
    }

    private static int BodyEnd(string raw, int from, int lineStart)
    {
        int e = lineStart;
        if (e > from && raw[e - 1] == '\n') e--;
        if (e > from && raw[e - 1] == '\r') e--;
        return e;
    }

    /// <summary>The body of every fenced block, in order. Locate searches these before the
    /// whole text, because a model told to fence its answer puts the answer there.</summary>
    public static IReadOnlyList<string> FencedBodies(string? raw)
    {
        if (raw == null) return Array.Empty<string>();
        return Fences(raw).Select(f => f.Body).ToList();
    }

    /// <summary>
    /// Removes any markdown code-fence wrapper from <paramref name="raw"/>.
    /// Returns the fence body (with surrounding prose) trimmed, or the trimmed raw input if no fence.
    /// Returns <c>""</c> for null input.
    /// </summary>
    public static string Apply(string? raw)
    {
        if (raw == null) return "";
        var fences = Fences(raw);
        if (fences.Count > 0)
        {
            var f = fences[0];
            return (raw[..f.Start] + f.Body + raw[f.End..]).Trim();
        }
        return raw.Trim();
    }
}
