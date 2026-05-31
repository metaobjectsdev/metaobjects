using System.Text.RegularExpressions;

namespace MetaObjects.Render.Extract;

/// <summary>
/// Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate.
/// </summary>
public static class Strip
{
    // Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
    private static readonly Regex Fence = new(
        @"```[a-zA-Z0-9_\-]*\s*\r?\n(.*?)\r?\n?```",
        RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// Removes any markdown code-fence wrapper from <paramref name="raw"/>.
    /// Returns the fence body (with surrounding prose) trimmed, or the trimmed raw input if no fence.
    /// Returns <c>""</c> for null input.
    /// </summary>
    public static string Apply(string? raw)
    {
        if (raw == null) return "";
        var m = Fence.Match(raw);
        if (m.Success)
        {
            int end = m.Index + m.Length;
            return (raw[..m.Index] + m.Groups[1].Value + raw[end..]).Trim();
        }
        return raw.Trim();
    }
}
