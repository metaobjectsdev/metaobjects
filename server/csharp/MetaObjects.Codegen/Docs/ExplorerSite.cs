// The model explorer site every port's docs-site generator writes (docs/features/explorer-site.md):
// the shared explorer app (the same bytes in every port, synced from explorer-app/ by
// scripts/sync-explorer-app.sh and embedded in this package), the explorer's theme pair, which a
// project may own under codegen/docs-site/assets/, and three data files built from the docs view:
// explorer.json, explorer-model.js and explorer-stamp.js. Mirrors the Java port's ExplorerSite.

using System.Text.Json.Nodes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Docs;

/// <summary>The files of the model explorer site, by path under the site directory.</summary>
public static class ExplorerSite
{
    public const string ModelFile = "explorer-model.js";
    public const string StampFile = "explorer-stamp.js";
    public const string ViewFile = "explorer.json";

    /// <summary>The app's files, as the shared copy holds them.</summary>
    public static readonly IReadOnlyList<string> AppFiles =
    [
        "index.html",
        "assets/explorer-app.js",
        "assets/explorer.css",
        "assets/explorer.js",
        "assets/cytoscape.min.js",
        "assets/3d-force-graph.min.js",
    ];

    /// <summary>The theme pair: an owned copy under <c>codegen/docs-site/assets/</c> replaces the shipped one.</summary>
    public static readonly IReadOnlyList<string> ThemeAssets = ["explorer.css", "explorer.js"];

    /// <summary>The page templates a project may own under <c>codegen/docs-site/templates/</c>; the app reads them from the model script.</summary>
    public static readonly IReadOnlyList<string> TemplateNames =
    [
        "explorer-head.mustache",
        "explorer-foot.mustache",
        "explorer-card.mustache",
        "explorer-overview.html.mustache",
        "explorer-map.html.mustache",
        "explorer-object.html.mustache",
        "explorer-node.html.mustache",
        "explorer-prompt.html.mustache",
        "explorer-prompts.html.mustache",
        "explorer-requirements.html.mustache",
        "explorer-requirement.html.mustache",
        "explorer-matrix.html.mustache",
        "explorer-trace.html.mustache",
        "explorer-gaps.html.mustache",
        "explorer-api.html.mustache",
        "explorer-model.html.mustache",
        "explorer-package.html.mustache",
    ];

    private const string ResourceRoot = "explorer-app/";

    /// <summary>What the site is built from. <paramref name="AssetsDir"/> and
    /// <paramref name="TemplatesDir"/> are the project's owned copies, or null.</summary>
    public sealed record Input(JsonObject View, string Title, string Footer, IReadOnlyDictionary<string, string> Texts,
        string? AssetsDir, string? TemplatesDir);

    /// <summary>Every file of the site, path to content, in a fixed order.</summary>
    public static IReadOnlyList<KeyValuePair<string, string>> Emit(Input input)
    {
        var files = new List<KeyValuePair<string, string>>();
        foreach (var f in AppFiles)
        {
            if (f.StartsWith("assets/", StringComparison.Ordinal) && ThemeAssets.Contains(f["assets/".Length..])) continue;
            files.Add(new(f, Resource(f)));
        }
        foreach (var a in ThemeAssets)
            files.Add(new("assets/" + a, ReadIfPresent(input.AssetsDir, a) ?? Resource("assets/" + a)));
        var templates = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in TemplateNames)
            if (ReadIfPresent(input.TemplatesDir, name) is { } owned) templates[name] = owned;
        var model = ExplorerModelScript.Of(input.Title, input.Footer, input.Texts, templates, input.View);
        files.Add(new(ModelFile, model.Script));
        files.Add(new(StampFile, ExplorerModelScript.StampScript(model.Stamp)));
        files.Add(new(ViewFile, DocsView.Serialize(input.View)));
        return files;
    }

    /// <summary>
    /// Each template node's prompt text, by node id: the file its <c>@textRef</c> names (with
    /// <c>.mustache</c> appended), found in the first of <paramref name="dirs"/> that holds it. A
    /// reference that is absolute or has an empty or <c>..</c> segment is never read.
    /// </summary>
    public static SortedDictionary<string, string> ReadPromptTexts(JsonObject view, IReadOnlyList<string> dirs)
    {
        var texts = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var node in view["nodes"]!.AsArray())
        {
            string? textRef = null;
            foreach (var attr in node!["attrs"]!.AsArray())
            {
                if (attr!["name"]!.GetValue<string>() == TEMPLATE_ATTR_TEXT_REF
                    && attr["value"] is JsonValue v && v.TryGetValue<string>(out var s))
                    textRef = s;
            }
            if (textRef is null) continue;
            var segments = textRef.Split('/', '\\');
            bool unsafeRef = Path.IsPathRooted(textRef) || textRef.StartsWith('/') || textRef.StartsWith('\\')
                || segments.Any(seg => seg.Length == 0 || seg == "..");
            if (unsafeRef) continue;
            foreach (var dir in dirs)
            {
                var parts = segments.ToArray();
                parts[^1] += ".mustache";
                var p = Path.Combine([dir, .. parts]);
                if (!File.Exists(p)) continue;
                texts[node["id"]!.GetValue<string>()] = File.ReadAllText(p);
                break;
            }
        }
        return texts;
    }

    private static string? ReadIfPresent(string? dir, string name)
    {
        if (dir is null) return null;
        var p = Path.Combine(dir, name);
        return File.Exists(p) ? File.ReadAllText(p) : null;
    }

    private static string Resource(string rel)
    {
        using var stream = typeof(ExplorerSite).Assembly.GetManifestResourceStream(ResourceRoot + rel)
            ?? throw new InvalidOperationException($"docs-site: the explorer app file {rel} is not embedded in MetaObjects.Codegen");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
