namespace MetaObjects.Cli;

/// <summary>
/// One advisory finding of a model authoring lint (<see cref="OverlayLint"/>, <see cref="NameLint"/>,
/// <see cref="DeprecationLint"/>): its code, the node's address (<c>""</c> when the finding is about a
/// file, not a node), and the message. A finding is always a warning: no lint reaches the exit code.
/// </summary>
public sealed record LintFinding(string Code, string Path, string Message);

/// <summary>The one string quoting the lints share.</summary>
internal static class LintText
{
    /// <summary>
    /// <c>JSON.stringify</c> of a string, so the message text is byte-identical to the TypeScript
    /// reference: only <c>"</c>, <c>\</c> and the C0 controls are escaped, and everything else, a
    /// no-break space or a byte-order mark included, is written as itself.
    /// </summary>
    internal static string Quote(string value)
    {
        var sb = new System.Text.StringBuilder(value.Length + 2).Append('"');
        foreach (var c in value)
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
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    /// <summary>Print one lint section: its header, then a line per finding. Nothing for no findings.</summary>
    internal static void Print(TextWriter stderr, string header, IReadOnlyList<LintFinding> findings)
    {
        if (findings.Count == 0) return;
        stderr.WriteLine($"dotnet meta verify — {header} (advisory — does not fail the build):");
        foreach (var f in findings)
            stderr.WriteLine(f.Path == "" ? $"  {f.Code}: {f.Message}" : $"  {f.Code} [{f.Path}]: {f.Message}");
    }
}
