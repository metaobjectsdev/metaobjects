using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// FR-023: metadata a project IMPORTS loads so its own model resolves against it, but is not the
/// project's to generate. Every registered generator must leave an imported node out of its output;
/// the one exception is a value object a generated entity holds, whose POCO the entity's property type
/// needs to compile. The corpus (fixtures/dependency-conformance/) pins the predicates; this pins that
/// the generators honour them.
/// </summary>
public sealed class DependencyCodegenTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-dep-codegen-" + Guid.NewGuid().ToString("N"));
    private string OutDir => Path.Combine(_tmp, "generated");

    // render-helper needs a template root for its drift gate; template is a primitive configured by its caller.
    private static readonly string[] Excluded = ["render-helper", "template"];

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private static JsonElement Case(string name)
    {
        var path = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "dependency-conformance", "cases.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("cases").EnumerateArray()
            .Single(c => c.GetProperty("name").GetString() == name).Clone();
    }

    /// <summary>
    /// Lays out the corpus's one-dependency project (a local <c>app::Order</c>, an imported
    /// <c>acme::common</c> with Address / Audited / Customer), plus an optional extra local file.
    /// </summary>
    private void Project(string? extraLocalFile = null)
    {
        var c = Case("a-dependency-adds-its-artifact-to-the-resolved-set");
        foreach (var f in c.GetProperty("tree").EnumerateObject())
            Write(f.Name, f.Value.GetString()!);
        foreach (var f in c.GetProperty("treeFiles").EnumerateObject())
        {
            var dest = Path.Combine(_tmp, f.Name);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "dependency-conformance", f.Value.GetString()!), dest);
        }
        Write(".metaobjects/config.json", c.GetProperty("config").GetRawText());
        Write(".metaobjects/deps.lock.json", c.GetProperty("lock").GetRawText());
        if (extraLocalFile is not null) Write("metaobjects/meta.extra.json", extraLocalFile);
    }

    private void Write(string rel, string content)
    {
        var path = Path.Combine(_tmp, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    private Dictionary<string, string> GenerateAll()
    {
        var load = MetadataLocation.Resolve(null, _tmp).Load();
        Assert.Empty(load.Errors);
        // The import is on the loaded root: that is what the generators read.
        Assert.NotNull(load.Root.ImportScope);
        var config = new GenConfig { OutDir = OutDir, Namespace = "Acme.Generated" };
        var names = GeneratorRegistry.Entries.Keys.Where(n => !Excluded.Contains(n)).ToList();
        CodegenRunner.Run(config, load.Root, GeneratorRegistry.Resolve(names));
        return Directory.EnumerateFiles(OutDir, "*", SearchOption.AllDirectories)
            .ToDictionary(p => Path.GetRelativePath(OutDir, p).Replace('\\', '/'), File.ReadAllText);
    }

    [Fact]
    public void An_imported_node_emits_nothing_from_any_registered_generator()
    {
        Project();
        var output = GenerateAll();

        // The project's own entity IS generated, so the run is not vacuous.
        Assert.Contains(output, kv => kv.Key.Contains("Order"));
        Assert.Contains(output, kv => kv.Value.Contains("Order"));

        foreach (var (path, text) in output)
        {
            Assert.DoesNotContain("Customer", path);
            Assert.DoesNotContain("Address", path);
            Assert.DoesNotContain("Audited", path);
            Assert.False(text.Contains("Customer") || text.Contains("Address") || text.Contains("acme.common", StringComparison.OrdinalIgnoreCase),
                $"{path} mentions an imported node");
        }
    }

    [Fact]
    public void An_imported_value_object_a_local_entity_holds_is_still_emitted()
    {
        Project("""
        { "metadata.root": { "package": "app", "children": [
          { "object.entity": { "name": "Invoice", "children": [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { "name": "id" } },
            { "field.object": { "name": "billTo", "@objectRef": "acme::common::Address", "@storage": "jsonb" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """);
        var output = GenerateAll();

        // The entity's property type needs the POCO to compile, so it is the one imported shape emitted.
        Assert.Contains(output, kv => kv.Value.Contains("class Address"));
        // The imported ENTITY that nothing local holds is still not emitted.
        Assert.DoesNotContain(output, kv => kv.Key.Contains("Customer") || kv.Value.Contains("Customer"));
    }

    [Fact]
    public void Naming_the_package_in_scope_include_generates_it()
    {
        Project();
        var cfgPath = Path.Combine(_tmp, ".metaobjects", "config.json");
        var cfg = JsonDocument.Parse(File.ReadAllText(cfgPath)).RootElement;
        Write(".metaobjects/config.json", cfg.GetRawText().TrimEnd('}') + ",\"scope\":{\"include\":[\"acme::common::**\",\"app::**\"]}}");

        var output = GenerateAll();
        Assert.Contains(output, kv => kv.Key.Contains("Customer"));
    }
}
