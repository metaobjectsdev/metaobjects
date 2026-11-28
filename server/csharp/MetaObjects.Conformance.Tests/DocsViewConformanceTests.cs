// The docs view corpus (fixtures/explorer-conformance/, docs/features/docs-view.md): each fixture's
// project is loaded strictly, its committed optional inputs are read, and DocsView must reproduce
// the fixture's expected.json byte for byte, as the TypeScript reference does. A fixture's
// provider.json is applied before loading, every type it declares a plain node.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class DocsViewConformanceTests
{
    /// <summary>A node of a type a fixture's provider.json declares: no behaviour beyond MetaData's own.</summary>
    private sealed class FixtureNode(TypeId typeId, string name) : MetaData(typeId, name);

    /// <summary>A provider for a fixture's provider.json: every type a plain node, its attrs and child slots as declared.</summary>
    private sealed class FixtureProvider(JsonElement def) : IMetaDataTypeProvider
    {
        public string Id => def.GetProperty("provider").GetString()!;
        public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

        public void RegisterTypes(TypeRegistry registry)
        {
            foreach (var type in def.GetProperty("types").EnumerateArray())
            {
                var (rules, attrs) = Slots(type.GetProperty("children"));
                registry.Register(new TypeDefinition(
                    typeId: new TypeId(type.GetProperty("type").GetString()!, type.GetProperty("subType").GetString()!),
                    description: type.GetProperty("description").GetString()!,
                    childRules: rules,
                    factory: (typeId, name) => new FixtureNode(typeId, name),
                    attributes: attrs));
            }
            foreach (var ext in def.GetProperty("extends").EnumerateArray())
            {
                var (rules, attrs) = Slots(ext.GetProperty("children"));
                registry.Extend(ext.GetProperty("type").GetString()!, ext.GetProperty("subType").GetString()!, attrs, rules);
            }
        }

        private static (List<ChildRule>, List<AttrSchema>) Slots(JsonElement children)
        {
            var rules = new List<ChildRule>();
            var attrs = new List<AttrSchema>();
            foreach (var slot in children.EnumerateArray())
            {
                string type = slot.GetProperty("type").GetString()!;
                string name = slot.GetProperty("name").GetString()!;
                if (type == TYPE_ATTR)
                {
                    attrs.Add(new AttrSchema(name, slot.GetProperty("subType").GetString(),
                        Required: slot.GetProperty("min").GetInt32() > 0,
                        Description: slot.TryGetProperty("description", out var d) ? d.GetString()! : "",
                        IsArray: slot.TryGetProperty("isArray", out var a) && a.GetBoolean()));
                }
                else
                {
                    rules.Add(new ChildRule(type, slot.GetProperty("subType").GetString()!, name));
                }
            }
            return (rules, attrs);
        }
    }

    internal static string Corpus()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures", "explorer-conformance")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "explorer-conformance");
    }

    private static List<string> FixtureNames() =>
        Directory.GetDirectories(Corpus()).Select(d => Path.GetFileName(d)).Order(StringComparer.Ordinal).ToList();

    public static TheoryData<string> Fixtures()
    {
        var data = new TheoryData<string>();
        foreach (var d in FixtureNames()) data.Add(d);
        return data;
    }

    private static JsonNode? ReadJson(string dir, string name)
    {
        string p = Path.Combine(dir, name);
        return File.Exists(p) ? JsonNode.Parse(File.ReadAllText(p)) : null;
    }

    /// <summary>A fixture's project, loaded strictly with its provider.json applied.</summary>
    internal static MetaRoot Load(string name)
    {
        string dir = Path.Combine(Corpus(), name);
        var providers = new List<IMetaDataTypeProvider>(CoreTypes.LibraryProviders);
        string providerFile = Path.Combine(dir, "provider.json");
        if (File.Exists(providerFile))
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(providerFile));
            providers.Add(new FixtureProvider(doc.RootElement.Clone()));
        }
        var result = MetaDataLoader.FromDirectory(Path.Combine(dir, "project", "metaobjects"),
            Provider.ComposeRegistry(providers), strict: true);
        Assert.True(result.Errors.Count == 0,
            $"{name}: expected a clean strict load, got: {string.Join("; ", result.Errors.Select(e => e.Message))}");
        return result.Root;
    }

    [Fact]
    public void CorpusHoldsTheFixturesTheReadmeDescribes() =>
        Assert.Equal(["crm", "model-alone", "shop"], FixtureNames());

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void ReproducesExpectedJson(string name)
    {
        string dir = Path.Combine(Corpus(), name);
        string expected = File.ReadAllText(Path.Combine(dir, "expected.json"));
        string actual = DocsView.Serialize(DocsView.Build(Load(name),
            ReadJson(dir, "verify.json"), ReadJson(dir, "hashes.json"), ReadJson(dir, "routes.json")));
        if (expected != actual && Environment.GetEnvironmentVariable("DOCS_VIEW_ACTUAL_DIR") is { Length: > 0 } scratch)
            File.WriteAllText(Path.Combine(scratch, name + ".json"), actual);
        Assert.True(expected == actual,
            $"{name}: docs view differs from expected.json (set DOCS_VIEW_ACTUAL_DIR to write what this port builds)");
    }

    [Fact]
    public void JsonWriterMatchesJavaScript()
    {
        Assert.Equal("1.5", DocsViewJson.Number(1.5));
        Assert.Equal("3", DocsViewJson.Number(3.0));
        Assert.Equal("1e+21", DocsViewJson.Number(1e21));
        Assert.Equal("100000000000000000000", DocsViewJson.Number(1e20));
        Assert.Equal("0.000001", DocsViewJson.Number(0.000001));
        Assert.Equal("1e-7", DocsViewJson.Number(1e-7));
        Assert.Equal("-12.25", DocsViewJson.Number(-12.25));
        Assert.Equal("123.456", DocsViewJson.Number(123.456));
        Assert.Equal("9007199254740992", DocsViewJson.Number(1L << 53));
        Assert.Equal("\"a\\u0001<>& \\ud800\u2028\"", DocsViewJson.Quote("a\u0001<>& \ud800\u2028"));
    }
}
