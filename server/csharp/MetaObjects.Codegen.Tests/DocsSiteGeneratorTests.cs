// docs-site: the model explorer this port writes with no Node. The docs view's bytes are held to
// fixtures/explorer-conformance/ by MetaObjects.Conformance.Tests; these tests hold what the generator
// adds: the shared app's bytes, the run's own files listed in the view (so the generator runs after
// every other entry), the drift gate rendering what gen wrote, the owned theme and templates, the
// prompt-text path rules, and the model script pinned to TypeScript's.

using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using MetaObjects.Codegen.Docs;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class DocsSiteGeneratorTests : IDisposable
{
    private readonly string _project = Path.Combine(
        Environment.GetEnvironmentVariable("DEV_SCRATCH") is { Length: > 0 } s ? s : Path.GetTempPath(),
        "mo-docs-site-" + Guid.NewGuid().ToString("N"));

    public void Dispose() { try { Directory.Delete(_project, recursive: true); } catch { } }

    private static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "explorer-conformance"))) return dir.FullName;
        throw new InvalidOperationException("repository root not found");
    }

    /// <summary>The shop fixture's project, copied into a scratch directory.</summary>
    private MetaRoot ShopProject()
    {
        Copy(Path.Combine(RepoRoot(), "fixtures", "explorer-conformance", "shop", "project"), _project);
        var load = MetaDataLoader.FromDirectory(Path.Combine(_project, "metaobjects"), strict: true);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static void Copy(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) Copy(d, Path.Combine(to, Path.GetFileName(d)));
    }

    private GenConfig Config() => new()
    {
        OutDir = Path.Combine(_project, "gen"),
        ProjectRoot = _project,
        GenStateDir = Path.Combine(_project, ".metaobjects", ".gen-state"),
        Namespace = "Shop",
    };

    private string Site(string file) => File.ReadAllText(Path.Combine(_project, "gen", "site", file));

    [Fact]
    public void Writes_the_shared_app_and_the_three_data_files()
    {
        CodegenRunner.Run(Config(), ShopProject(), [new DocsSiteGenerator()]);
        var app = Path.Combine(RepoRoot(), "explorer-app");
        foreach (var f in ExplorerSite.AppFiles)
            Assert.True(File.ReadAllText(Path.Combine(app, f)) == Site(f), $"{f} differs from explorer-app/");
        var view = (JsonObject)JsonNode.Parse(Site(ExplorerSite.ViewFile))!;
        Assert.Equal(DocsView.Format, view["format"]!.GetValue<string>());
        var stamp = Site(ExplorerSite.StampFile);
        Assert.Matches("^window\\.MO_STAMP = \"[0-9a-f]{16}\";\n$", stamp);
        Assert.StartsWith("window.MO_MODEL = {\"stamp\":" + stamp["window.MO_STAMP = ".Length..^2] + ",\"title\":",
            Site(ExplorerSite.ModelFile));
    }

    [Fact]
    public void Lists_the_files_the_run_generated_even_when_declared_first()
    {
        // Declared before the allowlist generator: the runner runs it last, so it sees the allowlist files.
        CodegenRunner.Run(Config(), ShopProject(), [new DocsSiteGenerator(), new FilterAllowlistGenerator()]);
        var view = (JsonObject)JsonNode.Parse(Site(ExplorerSite.ViewFile))!;
        Assert.True(view["sources"]!["files"]!.GetValue<bool>());
        var listed = view["nodes"]!.AsArray()
            .SelectMany(n => n!["files"]!.AsArray())
            .Where(g => g!["generatedBy"]!.GetValue<string>() == "filter-allowlist")
            .SelectMany(g => g!["paths"]!.AsArray().Select(p => p!.GetValue<string>()))
            .ToList();
        Assert.NotEmpty(listed);
        foreach (var p in listed)
        {
            Assert.StartsWith("gen/", p);
            Assert.True(File.Exists(Path.Combine(_project, p)), $"listed {p}, which the run did not write");
        }
    }

    [Fact]
    public void The_drift_gate_renders_what_gen_wrote()
    {
        var root = ShopProject();
        IReadOnlyList<IGenerator> suite = [new FilterAllowlistGenerator(), new DocsSiteGenerator()];
        CodegenRunner.Run(Config(), root, suite);
        var drift = CodegenDrift.Compute(Config(), root, suite);
        Assert.True(drift.Clean, string.Join("\n", drift.Lines));
    }

    [Fact]
    public void A_file_the_run_deletes_is_not_listed()
    {
        // A generator dropped from the list: the run's orphan sweep deletes its files, so the site
        // the same run writes must not list them, and the drift gate must render that same site.
        var root = ShopProject();
        var config = Config() with { SweepOrphans = true };
        CodegenRunner.Run(config, root, [new EntityGenerator(), new FilterAllowlistGenerator(), new DocsSiteGenerator()]);
        Assert.Contains(HashManifest.LoadProvenance(config.GenStateDir!), e => e.Value.GeneratedBy == "filter-allowlist");
        IReadOnlyList<IGenerator> suite = [new EntityGenerator(), new DocsSiteGenerator()];
        CodegenRunner.Run(config, root, suite);
        var view = (JsonObject)JsonNode.Parse(Site(ExplorerSite.ViewFile))!;
        var listed = view["nodes"]!.AsArray()
            .SelectMany(n => n!["files"]!.AsArray())
            .SelectMany(g => g!["paths"]!.AsArray().Select(p => p!.GetValue<string>()))
            .ToList();
        Assert.NotEmpty(listed);
        foreach (var p in listed) Assert.True(File.Exists(Path.Combine(_project, p)), $"listed {p}, which the run deleted");
        var drift = CodegenDrift.Compute(config, root, suite);
        Assert.True(drift.Clean, string.Join("\n", drift.Lines));
    }

    [Fact]
    public void A_site_generated_alone_lists_no_files_but_knows_the_run()
    {
        var root = ShopProject();
        var config = Config() with { SweepOrphans = true };
        CodegenRunner.Run(config, root, [new EntityGenerator(), new DocsSiteGenerator()]);
        IReadOnlyList<IGenerator> suite = [new DocsSiteGenerator()];
        CodegenRunner.Run(config, root, suite);
        var view = (JsonObject)JsonNode.Parse(Site(ExplorerSite.ViewFile))!;
        // TypeScript's runDocsView: a run always knows its files, so an empty list is still a list.
        Assert.True(view["sources"]!["files"]!.GetValue<bool>());
        Assert.Empty(view["nodes"]!.AsArray().SelectMany(n => n!["files"]!.AsArray()));
        var drift = CodegenDrift.Compute(config, root, suite);
        Assert.True(drift.Clean, string.Join("\n", drift.Lines));
    }

    [Fact]
    public void An_owned_theme_and_template_replace_the_shipped_ones()
    {
        var root = ShopProject();
        var owned = Path.Combine(_project, DocsSiteGenerator.OwnedDocsSiteDir);
        Directory.CreateDirectory(Path.Combine(owned, "assets"));
        Directory.CreateDirectory(Path.Combine(owned, "templates"));
        File.WriteAllText(Path.Combine(owned, "assets", "explorer.css"), "/* owned */\n");
        File.WriteAllText(Path.Combine(owned, "templates", "explorer-card.mustache"), "<b>{{name}}</b>");
        CodegenRunner.Run(Config(), root, [new DocsSiteGenerator()]);
        Assert.Equal("/* owned */\n", Site("assets/explorer.css"));
        Assert.Contains("\"templates\":{\"explorer-card.mustache\":\"<b>{{name}}</b>\"}", Site(ExplorerSite.ModelFile));
    }

    [Fact]
    public void A_prompt_text_is_read_only_through_a_safe_reference()
    {
        var dir = Path.Combine(_project, "prompts");
        Directory.CreateDirectory(Path.Combine(dir, "sub"));
        File.WriteAllText(Path.Combine(dir, "sub", "ok.mustache"), "hello");
        File.WriteAllText(Path.Combine(_project, "secret.mustache"), "no");
        JsonObject Node(string id, string textRef) => new()
        {
            ["id"] = id,
            ["attrs"] = new JsonArray(new JsonObject { ["name"] = "textRef", ["value"] = textRef }),
        };
        var view = new JsonObject
        {
            ["nodes"] = new JsonArray(Node("a", "sub/ok"), Node("b", "../secret"), Node("c", "sub//ok"), Node("d", "/etc/passwd")),
        };
        var texts = ExplorerSite.ReadPromptTexts(view, [dir]);
        Assert.Equal(["a"], texts.Keys.ToList());
        Assert.Equal("hello", texts["a"]);
    }

    [Fact]
    public void The_model_script_matches_TypeScript()
    {
        // Pinned from TypeScript's explorerModelScript over the model-alone fixture's view, with
        // title "T \u2028", footer "f" and texts { b: "2", a: "1" } (keys written sorted).
        var view = (JsonObject)JsonNode.Parse(File.ReadAllText(
            Path.Combine(RepoRoot(), "fixtures", "explorer-conformance", "model-alone", "expected.json")))!;
        var m = ExplorerModelScript.Of("T \u2028", "f", new Dictionary<string, string> { ["b"] = "2", ["a"] = "1" }, null, view);
        Assert.Equal("8ae24964eac47e67", m.Stamp);
        Assert.Equal(10014, m.Script.Length);
        Assert.Equal("3ae42a3977b053c76481fd1d5e7ca83f5f84fc1902608dbaec21bfe2cdc3019e",
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(m.Script))).ToLowerInvariant());
        Assert.Equal("window.MO_STAMP = \"8ae24964eac47e67\";\n", ExplorerModelScript.StampScript(m.Stamp));
    }
}
