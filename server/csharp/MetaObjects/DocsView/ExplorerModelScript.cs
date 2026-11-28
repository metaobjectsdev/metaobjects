// The model explorer's data script (explorer-model.js) and its stamp (explorer-stamp.js), as every
// port writes them: `window.MO_MODEL = {"stamp":"<s>",<title, footer, texts, templates, view>};`,
// where the stamp is the first 16 hex digits of the SHA-256 of that object's compact JSON without
// the stamp. Mirrors TypeScript's explorer-model script and the Java port's ExplorerModelScript.

using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace MetaObjects;

/// <summary>The explorer's model script and the stamp that names its content.</summary>
public sealed record ExplorerModelScript(string Script, string Stamp)
{
    /// <summary>Build the script for <paramref name="view"/>; <paramref name="texts"/> (prompt
    /// texts by node id) and <paramref name="templates"/> (owned page templates by file name) are
    /// written in code-unit key order.</summary>
    public static ExplorerModelScript Of(string title, string? footer, IReadOnlyDictionary<string, string>? texts,
        IReadOnlyDictionary<string, string>? templates, JsonObject view)
    {
        var rest = new JsonObject
        {
            ["title"] = title,
            ["footer"] = footer ?? "",
            ["texts"] = Sorted(texts),
            ["templates"] = Sorted(templates),
            ["view"] = view.DeepClone(),
        };
        string json = DocsViewJson.Compact(rest);
        string stamp = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant()[..16];
        return new ExplorerModelScript("window.MO_MODEL = {\"stamp\":" + DocsViewJson.Quote(stamp) + "," + json[1..] + ";\n", stamp);
    }

    /// <summary>The stamp script: <c>window.MO_STAMP = "&lt;stamp&gt;";</c>.</summary>
    public static string StampScript(string stamp) => "window.MO_STAMP = " + DocsViewJson.Quote(stamp) + ";\n";

    private static JsonObject Sorted(IReadOnlyDictionary<string, string>? m)
    {
        var o = new JsonObject();
        if (m is null) return o;
        foreach (var k in m.Keys.Order(StringComparer.Ordinal)) o[k] = m[k];
        return o;
    }
}
