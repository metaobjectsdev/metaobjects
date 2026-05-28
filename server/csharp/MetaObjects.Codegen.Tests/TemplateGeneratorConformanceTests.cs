// Cross-port byte-equivalence harness for the C# TemplateGenerator factory.
//
// Mirrors the TS reference adapter:
// server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts
//
// Fixture format: fixtures/render-conformance/template-generator/README.md

using System.Text.Json;
using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen.Tests;

public class TemplateGeneratorConformanceTests
{
    private static readonly Dictionary<string, string> FieldTypeMap = new()
    {
        ["string"] = FIELD_SUBTYPE_STRING,
        ["long"] = FIELD_SUBTYPE_LONG,
        ["int"] = FIELD_SUBTYPE_INT,
        ["double"] = FIELD_SUBTYPE_DOUBLE,
        ["boolean"] = FIELD_SUBTYPE_BOOLEAN,
        ["date"] = FIELD_SUBTYPE_DATE,
    };

    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "render-conformance", "template-generator")))
        {
            var parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/render-conformance/template-generator not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "render-conformance", "template-generator");
    }

    public static IEnumerable<object[]> Fixtures()
    {
        var corpus = CorpusRoot();
        foreach (var dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
        {
            if (Path.GetFileName(dir).StartsWith("fixture-"))
                yield return new object[] { Path.GetFileName(dir), dir };
        }
    }

    private static MetaRoot BuildRoot(JsonElement meta)
    {
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "conformance");
        foreach (var e in meta.GetProperty("entities").EnumerateArray())
        {
            var obj = new MetaObject(
                new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY),
                e.GetProperty("name").GetString()!);
            foreach (var f in e.GetProperty("fields").EnumerateArray())
            {
                var typeStr = f.GetProperty("type").GetString()!;
                if (!FieldTypeMap.TryGetValue(typeStr, out var subtype))
                    throw new InvalidOperationException($"Unknown field type '{typeStr}'");
                obj.AddChild(new MetaField(
                    new TypeId(TYPE_FIELD, subtype),
                    f.GetProperty("name").GetString()!));
            }
            root.AddChild(obj);
        }
        root.Freeze();
        return root;
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void TemplateGeneratorConformance(string fixtureName, string fixtureDir)
    {
        var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtureDir, "meta.json"))).RootElement;
        var templateBody = File.ReadAllText(Path.Combine(fixtureDir, "template.mustache"));
        var walkJson = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtureDir, "walk.json"))).RootElement;

        var walkEntries = walkJson.EnumerateArray().Select(w => new
        {
            Entity = w.TryGetProperty("entity", out var e) ? e.GetString() : null,
            Data = (object)JsonElementToObject(w.GetProperty("data"))!,
            OutputPath = w.GetProperty("outputPath").GetString()!,
        }).ToList();

        var root = BuildRoot(meta);
        var byName = root.Objects().Select(o => o.Name).ToHashSet();
        foreach (var w in walkEntries)
        {
            if (w.Entity != null && !byName.Contains(w.Entity))
                throw new InvalidOperationException($"walk.json references unknown entity '{w.Entity}'");
        }

        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["conformance/template"] = templateBody,
        });
        var gen = TemplateGenerator.Create(
            name: fixtureName,
            template: "conformance/template",
            provider: provider,
            format: meta.GetProperty("format").GetString()!,
            walk: _ => walkEntries.Select(w => new TemplateWalkResult(w.Data, w.OutputPath)));

        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        var files = gen.Generate(ctx).ToList();

        var emittedPaths = files.Select(f => f.Path).OrderBy(p => p).ToList();
        var expectedPaths = walkEntries.Select(w => w.OutputPath).OrderBy(p => p).ToList();
        Assert.Equal(expectedPaths, emittedPaths);

        var expectedDir = Path.Combine(fixtureDir, "expected");
        foreach (var w in walkEntries)
        {
            var expectedFile = Path.Combine(expectedDir, w.OutputPath);
            Assert.True(File.Exists(expectedFile), $"missing expected/{w.OutputPath}");
            var expected = File.ReadAllText(expectedFile);
            var actual = files.First(f => f.Path == w.OutputPath).Content;
            Assert.Equal(expected, actual);
        }
    }

    private static object? JsonElementToObject(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                var dict = new Dictionary<string, object?>();
                foreach (var p in el.EnumerateObject())
                    dict[p.Name] = JsonElementToObject(p.Value);
                return dict;
            case JsonValueKind.Array:
                return el.EnumerateArray().Select(JsonElementToObject).ToList();
            case JsonValueKind.String:
                return el.GetString();
            case JsonValueKind.Number:
                if (el.TryGetInt64(out var l)) return l;
                return el.GetDouble();
            case JsonValueKind.True: return true;
            case JsonValueKind.False: return false;
            case JsonValueKind.Null: return null;
            default: throw new InvalidOperationException($"Unhandled JsonValueKind {el.ValueKind}");
        }
    }
}
