// ADR-0064 Amendment 1: the hash manifest is one file per model package. Runs the shared vectors
// (fixtures/codegen-skip-conformance/manifests.json) against this port's manifest store, and asserts
// what the vectors cannot: file-level separation, write-only-what-changed, and read-only loads.

using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class HashManifestPerPackageTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Environment.GetEnvironmentVariable("DEV_SCRATCH") is { Length: > 0 } s ? s : Path.GetTempPath(),
        "mo-pkg-hash-" + Guid.NewGuid().ToString("N"));

    private string StateDir => Path.Combine(_root, ".metaobjects", ".gen-state");
    private string HashesDir => Path.Combine(StateDir, ".hashes");

    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static JsonElement Vectors()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var p = Path.Combine(dir.FullName, "fixtures", "codegen-skip-conformance", "manifests.json");
            if (File.Exists(p)) return JsonDocument.Parse(File.ReadAllText(p)).RootElement.Clone();
        }
        throw new InvalidOperationException("manifests.json not found");
    }

    private static List<HashManifest.ManifestObject> VectorObjects(JsonElement v) =>
        v.GetProperty("objects").EnumerateArray()
            .Select(o => new HashManifest.ManifestObject(o.GetProperty("name").GetString()!, o.GetProperty("package").GetString()!))
            .ToList();

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

    [Fact]
    public void FileNames_match_the_vectors()
    {
        foreach (var c in Vectors().GetProperty("fileNames").EnumerateArray())
            Assert.Equal(c.GetProperty("file").GetString(), HashManifest.FileNameFor(Str(c, "package")));
    }

    [Fact]
    public void Placement_matches_the_vectors()
    {
        var v = Vectors();
        var objects = VectorObjects(v);
        foreach (var c in v.GetProperty("placement").EnumerateArray())
        {
            JsonElement? entry = c.TryGetProperty("entry", out var e) ? e : null;
            Assert.Equal(
                HashManifest.FileNameFor(Str(c, "package")),
                HashManifest.PlaceFile(c.GetProperty("path").GetString()!, entry, objects));
        }
    }


    [Fact]
    public void LegacySplit_matches_the_vectors()
    {
        var split = Vectors().GetProperty("legacySplit");
        var objects = VectorObjects(Vectors());
        Directory.CreateDirectory(StateDir);
        File.WriteAllText(Path.Combine(StateDir, ".hashes.json"), split.GetProperty("legacy").GetRawText());
        var ignore = Path.Combine(_root, ".metaobjects", ".gitignore");
        File.WriteAllText(ignore, split.GetProperty("gitignoreBefore").GetString());

        using (var batch = HashManifest.Batch(StateDir, objects))
        {
            Assert.True(HashManifest.HasLegacy(StateDir));
            // A session over a legacy manifest saves even when it records nothing new.
            var session = new HashManifest.Session(StateDir);
            session.Save();
            batch.Complete();
        }

        Assert.False(File.Exists(Path.Combine(StateDir, ".hashes.json")));
        var expected = split.GetProperty("files");
        var actualNames = Directory.GetFiles(HashesDir).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(expected.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).ToList(), actualNames);
        foreach (var f in expected.EnumerateObject())
        {
            using var actual = JsonDocument.Parse(File.ReadAllText(Path.Combine(HashesDir, f.Name)));
            Assert.Equal(f.Value.GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""),
                actual.RootElement.GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        }
        Assert.Equal(split.GetProperty("goldenText").GetString()!,
            File.ReadAllText(Path.Combine(HashesDir, split.GetProperty("goldenFile").GetString()!)));
        Assert.Equal(split.GetProperty("gitignoreAfter").GetString(), File.ReadAllText(ignore));

        // A second identical write changes no file.
        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        File.SetLastWriteTimeUtc(ignore, stamp);
        using (var batch = HashManifest.Batch(StateDir, objects))
        {
            HashManifest.Save(StateDir, HashManifest.Load(StateDir));
            batch.Complete();
        }
        foreach (var f in Directory.GetFiles(HashesDir)) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(ignore));
        Assert.Equal(split.GetProperty("gitignoreAfter").GetString(), File.ReadAllText(ignore));
    }

    [Fact]
    public void Provenance_matches_the_vectors()
    {
        var v = Vectors();
        var p = v.GetProperty("provenance");
        var objects = VectorObjects(v);
        Directory.CreateDirectory(HashesDir);
        foreach (var f in p.GetProperty("beforeFiles").EnumerateObject())
            File.WriteAllText(Path.Combine(HashesDir, f.Name), f.Value.GetRawText());
        var records = p.GetProperty("records").EnumerateArray().ToDictionary(
            r => r.GetProperty("path").GetString()!,
            r => new HashManifest.Provenance(r.GetProperty("generatedBy").GetString()!, Str(r, "sourceNode")));

        void Apply()
        {
            using var batch = HashManifest.Batch(StateDir, objects);
            HashManifest.RecordGeneratedProvenance(StateDir, records);
            batch.Complete();
        }
        Apply();

        var expected = p.GetProperty("afterFiles");
        Assert.Equal(expected.EnumerateObject().Select(f => f.Name).Order(StringComparer.Ordinal).ToList(),
            Directory.GetFiles(HashesDir).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
        foreach (var f in expected.EnumerateObject())
        {
            using var actual = JsonDocument.Parse(File.ReadAllText(Path.Combine(HashesDir, f.Name)));
            Assert.Equal(Canon(f.Value), Canon(actual.RootElement));
        }
        Assert.Equal(p.GetProperty("goldenText").GetString()!,
            File.ReadAllText(Path.Combine(HashesDir, p.GetProperty("goldenFile").GetString()!)));

        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        Apply();
        foreach (var f in Directory.GetFiles(HashesDir)) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
    }

    private static string Canon(JsonElement e) => JsonSerializer.Serialize(e);

    [Fact]
    public void The_real_entity_generator_stamps_its_entity_file_with_provenance()
    {
        var src = """
            { "metadata.root": { "package": "acme::shop", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.string": { "name": "id" } } ] } }
            ]}}
            """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(src, id: "shop.json")]);
        Assert.Empty(r.Errors);
        var config = new GenConfig
        {
            OutDir = Path.Combine(_root, "gen"), Namespace = "Probe", GenStateDir = StateDir, ProjectRoot = _root,
        };
        CodegenRunner.Run(config, r.Root, [new MetaObjects.Codegen.Generators.EntityGenerator()]);

        using var shop = JsonDocument.Parse(File.ReadAllText(Path.Combine(HashesDir, "acme.shop.json")));
        var entry = shop.RootElement.EnumerateObject().Single(p => p.Name.EndsWith("Order.g.cs")).Value;
        Assert.Equal(JsonValueKind.Object, entry.ValueKind);
        Assert.Equal("entity-generator", entry.GetProperty("generatedBy").GetString());
        Assert.Equal("acme::shop::Order", entry.GetProperty("sourceNode").GetString());
        Assert.True(entry.TryGetProperty("hash", out _));
    }

    private sealed class WholeModelFile : IGenerator
    {
        public string Name => "barrel";
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [new EmittedFile("index.g.cs", "// index\n")];
    }

    private sealed class OneEntity : PerEntityGenerator
    {
        public override string Name => "alpha";
        protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx) =>
            new($"{entity.Name}.alpha.cs", "// a\n");
    }

    [Fact]
    public void A_run_records_the_generator_and_node_for_a_per_entity_file_only()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Pkg("acme::shop", "Order"), id: "shop.json")]);
        Assert.Empty(r.Errors);
        var config = new GenConfig
        {
            OutDir = Path.Combine(_root, "gen"), Namespace = "Probe", GenStateDir = StateDir, ProjectRoot = _root,
        };
        CodegenRunner.Run(config, r.Root, [new OneEntity(), new WholeModelFile()]);

        using var shop = JsonDocument.Parse(File.ReadAllText(Path.Combine(HashesDir, "acme.shop.json")));
        var entry = shop.RootElement.GetProperty("gen/Order.alpha.cs");
        Assert.Equal(["hash", "generatedBy", "sourceNode"], entry.EnumerateObject().Select(x => x.Name).ToArray());
        Assert.Equal("alpha", entry.GetProperty("generatedBy").GetString());
        Assert.Equal("acme::shop::Order", entry.GetProperty("sourceNode").GetString());
        using var rootM = JsonDocument.Parse(File.ReadAllText(Path.Combine(HashesDir, ".root.json")));
        Assert.Equal(JsonValueKind.String, rootM.RootElement.GetProperty("gen/index.g.cs").ValueKind);

        // A second run changes no manifest file.
        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        CodegenRunner.Run(config, r.Root, [new OneEntity(), new WholeModelFile()]);
        foreach (var f in Directory.GetFiles(HashesDir)) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
    }

    private static readonly List<HashManifest.ManifestObject> Objs =
    [
        new("Order", "acme::shop"), new("Customer", "acme::crm"),
    ];

    private void Record(params (string Path, string Content)[] files)
    {
        using var batch = HashManifest.Batch(StateDir, Objs);
        var session = new HashManifest.Session(StateDir);
        foreach (var (path, content) in files) session.Record(path, content);
        session.Save();
        batch.Complete();
    }

    [Fact]
    public void A_change_in_one_package_rewrites_only_that_packages_file()
    {
        Record(("gen/Order.cs", "a"), ("gen/Customer.cs", "b"), ("gen/index.cs", "c"));
        Assert.Equal([".root.json", "acme.crm.json", "acme.shop.json"],
            Directory.GetFiles(HashesDir).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray());

        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        var crmBytes = File.ReadAllBytes(Path.Combine(HashesDir, "acme.crm.json"));

        Record(("gen/Order.cs", "a2"));
        Assert.NotEqual(stamp, File.GetLastWriteTimeUtc(Path.Combine(HashesDir, "acme.shop.json")));
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(Path.Combine(HashesDir, "acme.crm.json")));
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(Path.Combine(HashesDir, ".root.json")));
        Assert.Equal(crmBytes, File.ReadAllBytes(Path.Combine(HashesDir, "acme.crm.json")));

        // A no-op save writes nothing.
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        Record(("gen/Order.cs", "a2"), ("gen/Customer.cs", "b"));
        foreach (var f in Directory.GetFiles(HashesDir)) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
    }

    [Fact]
    public void A_package_that_loses_its_last_entry_loses_its_file_and_an_empty_manifest_keeps_root()
    {
        Record(("gen/Order.cs", "a"), ("gen/Customer.cs", "b"));
        using (var batch = HashManifest.Batch(StateDir, Objs))
        {
            HashManifest.Save(StateDir, new Dictionary<string, string> { ["gen/Customer.cs"] = HashManifest.ContentHash("b") });
            batch.Complete();
        }
        Assert.False(File.Exists(Path.Combine(HashesDir, "acme.shop.json")));
        Assert.True(File.Exists(Path.Combine(HashesDir, "acme.crm.json")));

        using (var batch = HashManifest.Batch(StateDir, Objs))
        {
            HashManifest.Save(StateDir, new Dictionary<string, string>());
            batch.Complete();
        }
        Assert.Equal([".root.json"], Directory.GetFiles(HashesDir).Select(Path.GetFileName).ToArray());
        Assert.Equal("{}\n", File.ReadAllText(Path.Combine(HashesDir, ".root.json")));
        Assert.True(HashManifest.Exists(StateDir));
    }

    [Fact]
    public void A_read_only_load_of_a_legacy_manifest_migrates_nothing()
    {
        Directory.CreateDirectory(StateDir);
        var legacy = Path.Combine(StateDir, ".hashes.json");
        const string text = "{\n  \"gen/Order.cs\": \"h1\"\n}\n";
        File.WriteAllText(legacy, text);

        Assert.True(HashManifest.Exists(StateDir));
        Assert.Equal("h1", HashManifest.Load(StateDir)["gen/Order.cs"]);
        Assert.True(HashManifest.IsRecorded(StateDir, "gen/Order.cs"));

        Assert.Equal(text, File.ReadAllText(legacy));
        Assert.False(Directory.Exists(HashesDir));
    }

    private sealed class PerObject : IGenerator
    {
        public string Name => "per-object";
        public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
            ctx.Root.Objects().Select(o => new EmittedFile($"{o.Name}.g.cs", $"// {o.Name}\n"))
                .Append(new EmittedFile("index.g.cs", "// index\n"));
    }

    private static string Pkg(string package, string name) => $$$"""
        { "metadata.root": { "package": "{{{package}}}", "children": [
          { "object.value": { "name": "{{{name}}}", "children": [ { "field.string": { "name": "label" } } ] } }
        ]}}
        """;

    [Fact]
    public void A_run_over_a_multi_package_model_writes_one_manifest_per_package_and_a_root_one()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Pkg("acme::shop", "Order"), id: "shop.json"),
            new InMemoryStringSource(Pkg("acme::crm", "Customer"), id: "crm.json"),
        ]);
        Assert.Empty(r.Errors);
        var config = new GenConfig { OutDir = Path.Combine(_root, "gen"), Namespace = "Probe", GenStateDir = StateDir };

        var result = CodegenRunner.Run(config, r.Root, [new PerObject()]);
        Assert.All(result.Files, f => Assert.Equal("written", f.Status));

        Assert.Equal([".root.json", "acme.crm.json", "acme.shop.json"],
            Directory.GetFiles(HashesDir).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray());
        Assert.False(File.Exists(Path.Combine(StateDir, ".hashes.json")));
        Assert.Contains("Order.g.cs", File.ReadAllText(Path.Combine(HashesDir, "acme.shop.json")));
        Assert.Contains("Customer.g.cs", File.ReadAllText(Path.Combine(HashesDir, "acme.crm.json")));
        Assert.Contains("index.g.cs", File.ReadAllText(Path.Combine(HashesDir, ".root.json")));

        // The next run changes nothing, and writes no manifest file.
        var stamp = DateTime.UtcNow.AddHours(-2);
        foreach (var f in Directory.GetFiles(HashesDir)) File.SetLastWriteTimeUtc(f, stamp);
        CodegenRunner.Run(config, r.Root, [new PerObject()]);
        foreach (var f in Directory.GetFiles(HashesDir)) Assert.Equal(stamp, File.GetLastWriteTimeUtc(f));
    }

    private string MigrateWith(string gitignore)
    {
        Directory.CreateDirectory(StateDir);
        File.WriteAllText(Path.Combine(StateDir, ".hashes.json"), "{\n  \"gen/Order.cs\": \"h1\"\n}\n");
        var ignore = Path.Combine(_root, ".metaobjects", ".gitignore");
        File.WriteAllText(ignore, gitignore);
        using (var batch = HashManifest.Batch(StateDir, Objs))
        {
            new HashManifest.Session(StateDir).Save();
            batch.Complete();
        }
        return File.ReadAllText(ignore);
    }

    [Fact]
    public void Migration_inserts_the_new_line_after_the_rule_when_there_is_no_legacy_line()
        => Assert.Equal(".gen-state/*\n!.gen-state/.hashes/\nother\n", MigrateWith(".gen-state/*\nother\n"));

    [Fact]
    public void Migration_only_drops_the_legacy_line_when_the_new_one_is_there()
        => Assert.Equal(".gen-state/*\n!.gen-state/.hashes/\n",
            MigrateWith(".gen-state/*\n!.gen-state/.hashes.json\n!.gen-state/.hashes/\n"));

    [Fact]
    public void Migration_leaves_a_gitignore_without_the_rule_alone()
        => Assert.Equal("node_modules\n", MigrateWith("node_modules\n"));

    [Fact]
    public void A_non_migrating_save_leaves_gitignore_alone()
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        var ignore = Path.Combine(_root, ".metaobjects", ".gitignore");
        File.WriteAllText(ignore, ".gen-state/*\n!.gen-state/.hashes.json\n");
        Record(("gen/Order.cs", "a"));
        Assert.Equal(".gen-state/*\n!.gen-state/.hashes.json\n", File.ReadAllText(ignore));
    }
}
