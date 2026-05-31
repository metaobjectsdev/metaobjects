using System.Text;

namespace MetaObjects.Render.Extract;

/// <summary>
/// FR-011: enum-variant normalization for the Coerce stage.
/// ASCII-only by design: enum members are ASCII identifiers, so a pure <c>[A-Za-z0-9]</c>
/// transform is byte-identical across ports and sidesteps locale case-folding (Turkish-I).
/// Mode comes from the <c>@normalize</c> attr (none|collapse|strip; default strip).
/// Mirrors the TS <c>normalizeEnum</c>.
/// </summary>
public static class Normalize
{
    /// <summary>
    /// ASCII-only enum normalization. Pure <c>[A-Za-z0-9]</c> transform -> byte-identical cross-port.
    /// <list type="bullet">
    /// <item><c>none</c> — identity.</item>
    /// <item><c>collapse</c> — ASCII-upper + trim + collapse runs of <c>[\s_-]+</c> to a single <c>_</c>.</item>
    /// <item><c>strip</c> — ASCII-upper + keep only <c>[A-Z0-9]</c>.</item>
    /// </list>
    /// </summary>
    public static string Enum(string s, NormalizeMode mode)
    {
        if (mode == NormalizeMode.None) return s;

        string up = AsciiUpper(s.Trim());
        return mode == NormalizeMode.Collapse ? CollapseSeparators(up) : StripNonAlnum(up);
    }

    /// <summary>ASCII-only uppercasing (a-z -> A-Z); all other code units pass through unchanged.</summary>
    private static string AsciiUpper(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (char c in s)
            sb.Append(c >= 'a' && c <= 'z' ? (char)(c - 32) : c);
        return sb.ToString();
    }

    /// <summary>Collapse runs of whitespace / underscore / hyphen into a single underscore (mirrors <c>/[\s_-]+/g -> "_"</c>).</summary>
    private static string CollapseSeparators(string s)
    {
        var sb = new StringBuilder(s.Length);
        bool inRun = false;
        foreach (char c in s)
        {
            if (IsSeparator(c))
            {
                if (!inRun)
                {
                    sb.Append('_');
                    inRun = true;
                }
            }
            else
            {
                sb.Append(c);
                inRun = false;
            }
        }
        return sb.ToString();
    }

    /// <summary>Keep only <c>[A-Z0-9]</c> (mirrors <c>/[^A-Z0-9]/g -> ""</c> on an already-uppercased string).</summary>
    private static string StripNonAlnum(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (char c in s)
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
                sb.Append(c);
        return sb.ToString();
    }

    /// <summary>
    /// True for a character matched by the JS <c>\s</c> class OR <c>_</c> OR <c>-</c>.
    /// JS <c>\s</c> covers ASCII whitespace plus a fixed set of Unicode spaces; the corpus
    /// only exercises ASCII space, but the full set keeps cross-port parity for the collapse mode.
    /// </summary>
    private static bool IsSeparator(char c)
    {
        if (c == '_' || c == '-') return true;
        switch (c)
        {
            case ' ':      // space
            case '\t':     // tab
            case '\n':     // line feed
            case '\v':     // vertical tab
            case '\f':     // form feed
            case '\r':     // carriage return
            case '\u00A0': // no-break space
            case '\u1680': // ogham space mark
            case '\u2028': // line separator
            case '\u2029': // paragraph separator
            case '\u202F': // narrow no-break space
            case '\u205F': // medium mathematical space
            case '\u3000': // ideographic space
            case '\uFEFF': // zero-width no-break space (BOM)
                return true;
            default:
                // U+2000..U+200A (en/em/thin spaces etc.) -- JS \s range.
                return c >= '\u2000' && c <= '\u200A';
        }
    }
}
