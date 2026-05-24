// XML-doc + [Obsolete] builder for a MetaData node, reading the 7 doc common attrs.
// notes is intentionally NEVER read — D5 contract.

using System.Text;
using MetaObjects.Core.Documentation;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Docs;

/// <summary>
/// Renders an XML-doc block + optional [Obsolete] attribute for a MetaData node.
/// Returns ("", null) when no relevant doc attrs are set. @notes is never read
/// (D5 contract: internal-only rationale must not reach user-facing output).
/// </summary>
public static class XmlDocBuilder
{
    /// <summary>
    /// Render an XML-doc block + optional [Obsolete] attribute for a MetaData node.
    /// Returns ("", null) when no relevant doc attrs are set. @notes is never read
    /// (D5 contract).
    /// </summary>
    public static (string XmlDoc, string? ObsoleteAttribute) Render(MetaData node)
    {
        // Effective attrs so inherited @description (etc.) on a node extending
        // an abstract base flows through (parity with TS readDocAttrs).
        string? desc       = node.Attr(DocumentationConstants.DOC_ATTR_DESCRIPTION) as string;
        string? title      = node.Attr(DocumentationConstants.DOC_ATTR_TITLE) as string;
        var aliases        = node.Attr(DocumentationConstants.DOC_ATTR_ALIASES) as IReadOnlyList<string>;
        var seeAlso        = node.Attr(DocumentationConstants.DOC_ATTR_SEE_ALSO) as IReadOnlyList<string>;
        string? deprecated = node.Attr(DocumentationConstants.DOC_ATTR_DEPRECATED) as string;
        string? replacedBy = node.Attr(DocumentationConstants.DOC_ATTR_REPLACED_BY) as string;
        // NOTE: DOC_ATTR_NOTES is intentionally not read here — D5 contract.

        var sb = new StringBuilder();

        if (!string.IsNullOrEmpty(desc))
        {
            (string summary, string? remainder) = SplitSummary(desc);
            sb.Append("/// <summary>").Append(EscapeXml(summary)).AppendLine("</summary>");
            if (remainder is not null || (aliases is { Count: > 0 }))
            {
                sb.AppendLine("/// <remarks>");
                if (remainder is not null)
                {
                    foreach (string line in remainder.Split('\n'))
                    {
                        sb.Append("/// ").AppendLine(EscapeXml(line));
                    }
                }
                if (aliases is { Count: > 0 })
                {
                    sb.Append("/// <para>Aliases: ")
                      .Append(string.Join(", ", aliases.Select(EscapeXml)))
                      .AppendLine(".</para>");
                }
                sb.AppendLine("/// </remarks>");
            }
        }
        else if (!string.IsNullOrEmpty(title))
        {
            sb.Append("/// <summary>").Append(EscapeXml(title)).AppendLine("</summary>");
        }

        if (seeAlso is { Count: > 0 })
        {
            foreach (string url in seeAlso)
            {
                sb.Append("/// <seealso href=\"").Append(EscapeXml(url)).AppendLine("\"/>");
            }
        }

        string? obsolete = null;
        if (!string.IsNullOrEmpty(deprecated))
        {
            string msg = !string.IsNullOrEmpty(replacedBy)
                ? $"{deprecated} Replaced by {replacedBy}."
                : deprecated;
            obsolete = $"[Obsolete(\"{EscapeCsString(msg)}\")]";
        }

        return (sb.ToString().TrimEnd(), obsolete);
    }

    /// <summary>Prefix every non-empty line of <paramref name="xmlDoc"/> with the given indent.</summary>
    public static string Indent(string xmlDoc, string indent)
    {
        if (string.IsNullOrEmpty(xmlDoc)) return xmlDoc;
        return string.Join("\n", xmlDoc.Split('\n').Select(l => l.Length == 0 ? l : indent + l));
    }

    private static (string Summary, string? Remainder) SplitSummary(string s)
    {
        int idx = s.IndexOf('\n');
        if (idx < 0) return (s, null);
        return (s.Substring(0, idx), s.Substring(idx + 1));
    }

    private static string EscapeXml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static string EscapeCsString(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
