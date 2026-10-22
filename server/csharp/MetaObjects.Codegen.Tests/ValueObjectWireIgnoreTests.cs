using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// A value-object member that is null is omitted on the wire via
/// <c>[JsonIgnore(WhenWritingNull)]</c>, but System.Text.Json throws InvalidOperationException
/// the first time it builds type info for a type carrying that condition on a NON-nullable value
/// type (<c>double</c>, <c>DateTimeOffset</c>), so every request that touched the owning entity
/// answered 500. The condition belongs on the nullable members only.
/// </summary>
public class ValueObjectWireIgnoreTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Leg", "children": [
        { "source.rdb": { "@table": "legs" } },
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "telemetry", "@objectRef": "acme::Telemetry", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "Telemetry", "children": [
        { "field.timestamp": { "name": "capturedAt", "@required": true } },
        { "field.double": { "name": "latitude", "@required": true } },
        { "field.int": { "name": "tempC" } },
        { "field.boolean": { "name": "live", "@required": true } },
        { "field.decimal": { "name": "fee", "@required": true, "@precision": 10, "@scale": 2 } },
        { "field.uuid": { "name": "token", "@required": true } },
        { "field.string": { "name": "tags", "isArray": true } },
        { "field.string": { "name": "note" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void A_non_nullable_value_type_member_carries_no_ignore_condition()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "model.json")]);
        Assert.Empty(r.Errors);
        var files = new EntityGenerator().Generate(new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        });
        var src = Assert.Single(files, f => f.Path == "Telemetry.g.cs").Content;

        var lines = src.Split('\n').Select(l => l.TrimEnd()).ToList();
        string[] Attrs(string decl) =>
            lines.TakeWhile(l => !l.Contains(decl)).Reverse().TakeWhile(l => l.TrimStart().StartsWith("[")).ToArray();

        Assert.DoesNotContain(Attrs("public double Latitude"), l => l.Contains("WhenWritingNull"));
        Assert.DoesNotContain(Attrs("public DateTimeOffset CapturedAt"), l => l.Contains("WhenWritingNull"));
        Assert.DoesNotContain(Attrs("public bool Live"), l => l.Contains("WhenWritingNull"));
        Assert.DoesNotContain(Attrs("public decimal Fee"), l => l.Contains("WhenWritingNull"));
        Assert.DoesNotContain(Attrs("public Guid Token"), l => l.Contains("WhenWritingNull"));
        Assert.Contains(Attrs("public int? TempC"), l => l.Contains("WhenWritingNull"));
        Assert.Contains(Attrs("public string? Note"), l => l.Contains("WhenWritingNull"));
    }
}
