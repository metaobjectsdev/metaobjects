// docs-site — the model explorer (docs/features/explorer-site.md): one browser app over the
// project's docs view, written with no Node. This port builds the docs view in memory from the
// loaded model (MetaObjects.DocsView), lists the files the run generated (with the generator and
// node each came from), and writes it as explorer.json beside the model script, the stamp and the
// shared explorer app. Mirrors the Java/Kotlin DocsSiteGenerator and TypeScript's docsSiteFile().
//
// An ordinary entry in codegen/Generators.cs (ADR-0034 Amendment 9). Exempt from eject: the site
// builder is engine; what a project changes is the explorer's theme (codegen/docs-site/assets/)
// and page templates (codegen/docs-site/templates/), which it owns and this generator reads.

using System.Text.Json.Nodes;
using MetaObjects.Codegen.Docs;
using MetaObjects.Config;

namespace MetaObjects.Codegen.Generators;

public sealed class DocsSiteGenerator : IGenerator
{
    public const string DefaultSubDir = "site";

    /// <summary>Where a project keeps its owned theme (<c>assets/</c>) and page templates (<c>templates/</c>).</summary>
    public const string OwnedDocsSiteDir = "codegen/docs-site";

    private const string DefaultGenStateDir = ".metaobjects/.gen-state";

    public string Name => "docs-site";

    /// <inheritdoc/>
    public string? OutDir { get; init; }

    /// <summary>The site's directory under the output directory; <c>""</c> writes at its root.</summary>
    public string SubDir { get; init; } = DefaultSubDir;

    /// <summary>The explorer's title; the project directory's name when unset ("Metadata" in a run that names no project).</summary>
    public string? Title { get; init; }

    /// <summary>The footer line (a build stamp, a version).</summary>
    public string Stamp { get; init; } = "";

    /// <summary>A directory of prompt texts, searched after the metadata directory, <c>templates/</c> and <c>prompts/</c>.</summary>
    public string? Prompts { get; init; }

    /// <summary>A <c>dotnet meta verify --format json</c> payload: adds the requirement ledger and its advisories.</summary>
    public string? VerifyFile { get; init; }

    /// <summary>A routes file (<c>[{ node, method, path }]</c>): adds each object's served routes.</summary>
    public string? RoutesFile { get; init; }

    public bool WholeModel => true;

    /// <summary>The docs site lists the files the run generated, so it runs after every other entry.</summary>
    public bool ReadsRunOutput => true;

    public IReadOnlyList<string> ExtraInputs =>
        new[] { OwnedDocsSiteDir, Prompts, VerifyFile, RoutesFile }.OfType<string>().ToList();

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // A run that names no project reads nothing beside the model it was handed: no committed
        // manifest, owned theme or prompt directory is found through the process's working
        // directory, which a host (or a parallel test) may change between gen and verify. Paths the
        // options name explicitly still resolve against it.
        var known = ctx.Config.InputRoot ?? ctx.Config.ProjectRoot;
        var project = Path.GetFullPath(known ?? Directory.GetCurrentDirectory());
        string Abs(string p) => Path.GetFullPath(Path.Combine(project, p));
        var verify = VerifyFile is null ? null : ReadJson(Abs(VerifyFile));
        var routes = RoutesFile is null ? null : ReadJson(Abs(RoutesFile));
        var genState = ctx.Config.GenStateDir ?? (known is null ? null : Path.Combine(project, DefaultGenStateDir));
        IReadOnlyDictionary<string, HashManifest.Provenance>? files = ctx.GeneratedFiles is { } run
            ? (run.Count > 0 ? run : null)
            : genState is not null && HashManifest.Exists(genState) ? HashManifest.LoadProvenance(genState) : null;
        var view = DocsView.Build(ctx.Root, verify, files is null ? null : ProvenanceJson(files), routes);

        var owned = Path.Combine(project, OwnedDocsSiteDir);
        var assets = Path.Combine(owned, "assets");
        var templates = Path.Combine(owned, "templates");
        var site = ExplorerSite.Emit(new ExplorerSite.Input(
            view,
            Title ?? (known is not null && Path.GetFileName(project.TrimEnd(Path.DirectorySeparatorChar)) is { Length: > 0 } dir ? dir : "Metadata"),
            Stamp,
            ExplorerSite.ReadPromptTexts(view, PromptDirs(ctx, project, known is not null)),
            known is not null && Directory.Exists(assets) ? assets : null,
            known is not null && Directory.Exists(templates) ? templates : null));
        var prefix = SubDir.TrimEnd('/') is { Length: > 0 } sub ? sub + "/" : "";
        foreach (var (path, content) in site)
            yield return new EmittedFile(prefix + path, content) { WholeModel = true };
    }

    private static JsonObject ProvenanceJson(IReadOnlyDictionary<string, HashManifest.Provenance> files)
    {
        var o = new JsonObject();
        foreach (var key in files.Keys.Order(StringComparer.Ordinal))
        {
            var entry = new JsonObject { ["generatedBy"] = files[key].GeneratedBy };
            if (files[key].SourceNode is { } node) entry["sourceNode"] = node;
            o[key] = entry;
        }
        return o;
    }

    /// <summary>Where a template's <c>@textRef</c> is looked up: the metadata directory, the
    /// project's <c>templates/</c> and <c>prompts/</c>, then <see cref="Prompts"/>.</summary>
    private List<string> PromptDirs(GenContext ctx, string project, bool projectKnown)
    {
        var dirs = new List<string>();
        void Add(string? d)
        {
            if (d is null) return;
            var full = Path.GetFullPath(Path.Combine(project, d));
            if (Directory.Exists(full) && !dirs.Contains(full)) dirs.Add(full);
        }
        if (projectKnown)
        {
            try { Add(MetadataLocation.Resolve(null, project).Directory); }
            // A project whose sources do not resolve still searches the other directories.
            catch (Exception e) when (e is MetadataLocationException or MetaModelException) { }
            Add(CodegenCli.LegacyTemplatesDir);
            Add(CodegenCli.DefaultPromptsDir);
        }
        if (Prompts is not null)
        {
            if (Directory.Exists(Path.Combine(project, Prompts))) Add(Prompts);
            else ctx.Warn($"docs-site: the prompts directory does not exist: {Prompts}");
        }
        return dirs;
    }

    private static JsonNode? ReadJson(string path) =>
        File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))
            : throw new InvalidOperationException($"docs-site: could not read {path}");
}
