// ADR-0064 — the shared table of skip cases (fixtures/codegen-skip-conformance/cases.json), run
// against this port's project shape: a codegen/ project (the generator list, an owned generator, a
// project reference to a linked engine checkout), a metadata directory with an abstract parent and
// a child, a template root and .metaobjects/config.json.
//
// Each case runs the owned runner's `gen` once (it must store a key), applies the case's change,
// then asks the two real decisions: a local `verify --codegen` first (it changes nothing) and
// `gen` second. The decisions are made inside the codegen process, after the load, so both are
// read from what that process prints.

using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Cli.Tests;

[Collection(OwnedRunnerCollection.Name)]
public sealed class GenSkipConformanceTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-skip-" + Guid.NewGuid().ToString("N"));
    private readonly string? _ci = Environment.GetEnvironmentVariable("CI");
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");
    private string P(string rel) => Path.Combine(_tmp, rel);

    private const string Parent = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.string": { "name": "tag" } }
      ]}}
    ]}}
    """;

    private const string Child = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Sub", "extends": "Base", "children": [
        { "source.rdb": { "@table": "subs" } },
        { "field.long":   { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private const string Order = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    /// <summary>A generator that declares an extra input and can mark itself uncacheable.</summary>
    private sealed class Custom(bool cacheable) : IGenerator
    {
        public string Name => "custom";
        public bool Cacheable => cacheable;
        public IReadOnlyList<string> ExtraInputs => ["extra/data.txt"];
        public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
            [new EmittedFile("Custom.g.cs", "// " + File.ReadAllText(Path.Combine(Directory.GetCurrentDirectory(), "extra", "data.txt")))];
    }

    public GenSkipConformanceTests()
    {
        Environment.SetEnvironmentVariable("CI", null);
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(P("metaobjects/meta.base.json"), Parent);
        File.WriteAllText(P("metaobjects/meta.sub.json"), Child);
        File.WriteAllText(P("metaobjects/meta.order.json"), Order);
        Directory.CreateDirectory(P(".metaobjects"));
        File.WriteAllText(P(".metaobjects/config.json"), """{ "schema_version": 1 }""");
        Directory.CreateDirectory(P("codegen/generators"));
        File.WriteAllText(P("codegen/Generators.cs"), "// the list v1\n");
        File.WriteAllText(P("codegen/generators/Own.cs"), "// an owned generator v1\n");
        Directory.CreateDirectory(P("engine"));
        File.WriteAllText(P("engine/Engine.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
        File.WriteAllText(P("engine/Engine.cs"), "// engine v1\n");
        File.WriteAllText(P("codegen/Codegen.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><ProjectReference Include=\"../engine/Engine.csproj\" /></ItemGroup></Project>\n");
        Directory.CreateDirectory(P("prompts"));
        File.WriteAllText(P("prompts/greeting.mustache"), "hello\n");
        File.WriteAllText(P("prompts/note.mustache"), "{{name}}\n");
        Directory.CreateDirectory(P("extra"));
        File.WriteAllText(P("extra/data.txt"), "one");
        File.WriteAllText(P("README.md"), "readme v1\n");
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("CI", _ci);
        try { Directory.Delete(_tmp, recursive: true); } catch { }
    }

    private string[] GenArgs(params string[] more) =>
        ["gen", MetaDir, "--out", OutDir, "--namespace", "Acme.Generated", .. more];

    private IReadOnlyList<IGenerator> Declared(bool uncacheable = false) =>
        [.. OwnedRunner.Declared(_tmp, "entity"), new Custom(!uncacheable)];

    /// <summary>The case that also configures a <c>template</c> generator and a docs page.</summary>
    private const string DocsCase = "template-and-docs-rerun";

    private IReadOnlyList<IGenerator> DeclaredWithDocs() =>
        [.. Declared(),
         TemplateGenerator.Create("note", "note",
             r => r.Objects().Where(o => !o.IsAbstract).Select(e => new TemplateWalkResult(new { name = e.Name }, $"notes/{e.Name}.txt")),
             new FilesystemProvider(P("prompts"))),
         new ApiDocsGenerator()];

    /// <summary>Every file under the given directories: its bytes and its modification time.</summary>
    private static List<(string Path, string Text, DateTime Stamp)> Snapshot(params string[] dirs) =>
        [.. dirs.Where(Directory.Exists)
            .SelectMany(d => Directory.GetFiles(d, "*", SearchOption.AllDirectories))
            .Order(StringComparer.Ordinal)
            .Select(f => (f, File.ReadAllText(f), File.GetLastWriteTimeUtc(f)))];

    private (int Exit, string Out, string Err) RunGen(IReadOnlyList<IGenerator> declared, params string[] more) =>
        Wrap(OwnedRunner.Run(_tmp, declared, GenArgs(more)));

    private static (int Exit, string Out, string Err) Wrap((int ExitCode, string Stdout, string Stderr) r) => (r.ExitCode, r.Stdout, r.Stderr);

    private const string GenSkipped = "nothing changed since the last run; skipped";
    private const string VerifyAnswered = "nothing changed since the last gen";

    /// <summary>What a local `verify --codegen` does, from what the codegen process prints. It changes nothing.</summary>
    private string VerifyDecision(IReadOnlyList<IGenerator> declared, string[] more, string? ci)
    {
        Environment.SetEnvironmentVariable("CI", ci);
        var full = more.Contains("--force") ? new[] { "--full" } : [];
        string[] gen = more.Where(m => m != "--force").ToArray();
        var r = OwnedRunner.Run(_tmp, declared,
            ["verify", "--codegen", MetaDir, "--out", OutDir, "--namespace", "Acme.Generated", .. gen, .. full]);
        Environment.SetEnvironmentVariable("CI", null);
        return r.Stdout.Contains(VerifyAnswered) ? "may-answer-no-drift" : "must-render";
    }

    /// <summary>What `gen` does: skip (renders and writes nothing) or regenerate.</summary>
    private string GenDecision(IReadOnlyList<IGenerator> declared, string[] more)
    {
        var r = RunGen(declared, more);
        return r.Out.Contains(GenSkipped) ? "skip" : "regenerate";
    }

    private static string CasesPath()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var p = Path.Combine(dir.FullName, "fixtures", "codegen-skip-conformance", "cases.json");
            if (File.Exists(p)) return p;
        }
        throw new InvalidOperationException("fixtures/codegen-skip-conformance/cases.json not found above " + AppContext.BaseDirectory);
    }

    public static IEnumerable<object[]> Cases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(CasesPath()));
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return [c.GetProperty("id").GetString()!, c.GetProperty("gen").GetString()!, c.GetProperty("verify").GetString()!];
    }

    private string FingerprintPath() => P(".metaobjects/.gen-state/" + GenFingerprint.FileName);

    [Theory]
    [MemberData(nameof(Cases))]
    public void The_case_table_decides_gen_and_verify(string id, string gen, string verify)
    {
        var declared = id == DocsCase ? DeclaredWithDocs() : Declared();
        var first = RunGen(declared);
        Assert.True(first.Exit == 0, first.Out + first.Err);
        Assert.NotNull(GenFingerprint.Read(_tmp));

        string[] more = [];
        string? ci = null;
        var legacy = false;
        switch (id)
        {
            case "no-change": break;
            case "metadata-touched":
                File.WriteAllText(P("metaobjects/meta.order.json"), Order);
                File.SetLastWriteTimeUtc(P("metaobjects/meta.order.json"), DateTime.UtcNow.AddHours(1));
                break;
            case "unrelated-file-edited": File.WriteAllText(P("README.md"), "readme v2\n"); break;
            case "metadata-reformatted":
                // Same content: different whitespace and object-key order (child order is meaningful and kept).
                File.WriteAllText(P("metaobjects/meta.order.json"),
                    """
                    {  "metadata.root": { "children": [
                      { "object.entity": { "children": [
                          { "source.rdb": { "@table": "orders" } },
                          { "field.long": { "name": "id" } },
                          { "identity.primary": { "@fields": "id" } } ],
                        "name": "Order" } } ],
                      "package": "acme" } }
                    """);
                break;
            case "metadata-moved":
                File.Delete(P("metaobjects/meta.order.json"));
                File.WriteAllText(P("metaobjects/meta.moved.json"), Order);
                break;
            case "metadata-edited":
                File.WriteAllText(P("metaobjects/meta.order.json"), Order.Replace("orders", "orders2"));
                break;
            case "metadata-added": File.WriteAllText(P("metaobjects/meta.extra.json"), Order.Replace("Order", "Extra")); break;
            case "metadata-removed": File.Delete(P("metaobjects/meta.order.json")); break;
            case "parent-edited":
                File.WriteAllText(P("metaobjects/meta.base.json"), Parent.Replace(
                    """{ "field.string": { "name": "tag" } }""",
                    """{ "field.string": { "name": "tag" } }, { "field.string": { "name": "note" } }"""));
                break;
            case "config-edited": File.WriteAllText(P("codegen/Generators.cs"), "// the list v2\n"); break;
            case "project-config-edited":
                File.WriteAllText(P(".metaobjects/config.json"), """{ "schema_version": 1, "csharp": { "namespace": "Other" } }""");
                break;
            case "template-edited": File.WriteAllText(P("prompts/greeting.mustache"), "hello again\n"); break;
            case "template-added": File.WriteAllText(P("prompts/farewell.mustache"), "bye\n"); break;
            case "owned-generator-edited": File.WriteAllText(P("codegen/generators/Own.cs"), "// an owned generator v2\n"); break;
            case "engine-changed": File.WriteAllText(P("engine/Engine.cs"), "// engine v2\n"); break;
            case "selection-changed": more = ["--generators", "entity"]; break;
            case "declared-extra-edited": File.WriteAllText(P("extra/data.txt"), "two"); break;
            case "uncacheable-generator": declared = Declared(uncacheable: true); break;
            case "hand-edit-kept":
                // The C# runner refuses (never merges) a hand edit, so the "run that kept it" is simulated:
                // edit, then store the key the way a successful run would, over the file as it now is.
                File.AppendAllText(Directory.GetFiles(OutDir).First(), "// hand edit\n");
                var stored = GenFingerprint.Read(_tmp)!;
                GenFingerprint.Write(_tmp, stored.Model, stored.Identity, stored.Untracked);
                break;
            case "generated-file-deleted": File.Delete(Directory.GetFiles(OutDir).First()); break;
            case "generated-file-edited": File.AppendAllText(Directory.GetFiles(OutDir).First(), "// hand edit\n"); break;
            case "fingerprint-missing": File.Delete(FingerprintPath()); break;
            case "force": more = ["--force"]; break;
            case "ci": ci = "true"; break;
            case "legacy-manifest":
                // Back to the pre-1.3.0 form: every file in .hashes/ merged into one .hashes.json, the directory removed.
                var merged = new SortedDictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal);
                foreach (var f in Directory.GetFiles(P(".metaobjects/.gen-state/.hashes"), "*.json"))
                    foreach (var kv in System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, System.Text.Json.JsonElement>>(File.ReadAllText(f))!)
                        merged[kv.Key] = kv.Value;
                File.WriteAllText(P(".metaobjects/.gen-state/.hashes.json"),
                    System.Text.Json.JsonSerializer.Serialize(merged, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) + "\n");
                Directory.Delete(P(".metaobjects/.gen-state/.hashes"), recursive: true);
                legacy = true;
                break;
            case "failed-run":
                var good = File.ReadAllText(P("metaobjects/meta.order.json"));
                File.WriteAllText(P("metaobjects/meta.order.json"), "{ not json");
                var bad = RunGen(declared);
                Assert.NotEqual(0, bad.Exit);
                File.WriteAllText(P("metaobjects/meta.order.json"), good);
                break;
            case DocsCase: break;
            default: Assert.Fail($"unknown case id '{id}': add it to this runner"); break;
        }

        // verify first: it changes nothing. gen second: a regenerate stores a new key.
        Assert.Equal(verify, VerifyDecision(declared, more, ci));
        if (legacy)
        {
            // verify is read-only: it migrates nothing.
            Assert.True(File.Exists(P(".metaobjects/.gen-state/.hashes.json")));
            Assert.False(Directory.Exists(P(".metaobjects/.gen-state/.hashes")));
        }
        Assert.Equal(gen, GenDecision(declared, more));
        if (legacy)
        {
            Assert.False(File.Exists(P(".metaobjects/.gen-state/.hashes.json")));
            Assert.NotEmpty(Directory.GetFiles(P(".metaobjects/.gen-state/.hashes"), "*.json"));
        }
        if (id == DocsCase)
        {
            // The template output and the docs page were written, and a forced render rewrites none.
            Assert.Equal("Order\n", File.ReadAllText(Path.Combine(OutDir, "notes", "Order.txt")));
            Assert.Contains(Directory.GetFiles(OutDir, "*.md", SearchOption.AllDirectories), f => f.Contains("api", StringComparison.OrdinalIgnoreCase));
            var before = Snapshot(OutDir, P(".metaobjects/.gen-state/.hashes"));
            Thread.Sleep(20);
            var forced = RunGen(declared, "--force");
            Assert.True(forced.Exit == 0, forced.Out + forced.Err);
            Assert.Equal(before, Snapshot(OutDir, P(".metaobjects/.gen-state/.hashes")));
        }
    }

    [Fact]
    public void A_skipped_gen_renders_nothing_and_leaves_every_file_and_the_key_untouched()
    {
        Assert.Equal(0, RunGen(Declared()).Exit);
        var files = Directory.GetFiles(OutDir).Concat(Directory.GetFiles(P(".metaobjects/.gen-state/.hashes"))).Append(FingerprintPath()).ToList();
        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in files) File.SetLastWriteTimeUtc(f, stamp);

        var again = RunGen(Declared());

        Assert.Contains(GenSkipped, again.Out);
        Assert.DoesNotContain("unchanged:", again.Out);
        foreach (var f in files) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
    }

    [Fact]
    public void An_entities_run_renders_never_stores_and_leaves_the_full_run_key_alone()
    {
        Assert.Equal(0, RunGen(Declared()).Exit);
        var key = File.ReadAllBytes(FingerprintPath());

        var narrowed = RunGen(Declared(), "--entities", "Order");
        Assert.Equal(0, narrowed.Exit);
        Assert.DoesNotContain(GenSkipped, narrowed.Out);
        Assert.Contains("Order", narrowed.Out);
        Assert.Equal(key, File.ReadAllBytes(FingerprintPath()));

        // A narrowed run that fails leaves the key alone too.
        Assert.Equal(2, RunGen(Declared(), "--entities", "NoSuchEntity").Exit);
        Assert.Equal(key, File.ReadAllBytes(FingerprintPath()));

        Assert.Contains(GenSkipped, RunGen(Declared()).Out);
    }

    [Fact]
    public void An_edit_regenerates_and_the_next_run_skips_again()
    {
        Assert.Equal(0, RunGen(Declared()).Exit);
        File.WriteAllText(P("metaobjects/meta.order.json"), Order.Replace("orders", "orders2"));
        Assert.Equal("regenerate", GenDecision(Declared(), []));
        Assert.Equal("skip", GenDecision(Declared(), []));
    }

    [Fact]
    public void The_model_hash_is_a_tree_whose_node_and_package_hashes_move_with_the_node()
    {
        var load = () => MetaObjects.Config.MetadataLocation.Resolve(MetaDir, _tmp).Load();
        var before = ModelHash.Of(load().Root);
        Assert.Contains(before.Nodes, n => n is { Package: "acme", Name: "Order" });
        File.WriteAllText(P("metaobjects/meta.order.json"), Order.Replace("orders", "orders2"));
        var after = ModelHash.Of(load().Root);

        Assert.NotEqual(before.Model, after.Model);
        Assert.NotEqual(before.Packages["acme"], after.Packages["acme"]);
        Assert.Equal(before.Nodes.Single(n => n.Name == "Sub").Hash, after.Nodes.Single(n => n.Name == "Sub").Hash);
        Assert.NotEqual(before.Nodes.Single(n => n.Name == "Order").Hash, after.Nodes.Single(n => n.Name == "Order").Hash);
    }
}
