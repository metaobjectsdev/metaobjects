using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Under <c>wire.nullMembers: omit</c> (ADR-0019 Amendment 2) a value-object member that is null
/// is omitted on the wire via <c>[JsonIgnore(WhenWritingNull)]</c>, but System.Text.Json throws InvalidOperationException
/// the first time it builds type info for a type carrying that condition on a NON-nullable value
/// type (<c>double</c>, <c>DateTimeOffset</c>), so every request that touched the owning entity
/// answered 500. The condition belongs on the nullable members only. The default (native) writes
/// the member as System.Text.Json does, <c>null</c> with its key present.
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

    [Theory]
    [InlineData(NullMemberForm.Omit)]
    [InlineData(NullMemberForm.Native)]
    public void A_value_object_with_required_value_type_members_round_trips_and_writes_a_null_optional_member_per_the_setting(NullMemberForm nulls)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "model.json")]);
        Assert.Empty(r.Errors);
        r.Root.WireFormat = new WireFormat(DecimalWireForm.String, nulls);
        var files = new EntityGenerator().Generate(new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        });
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path));
        var comp = CSharpCompilation.Create("vo_wire_ignore_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var telemetry = Assembly.Load(ms.ToArray()).GetTypes().Single(t => t.Name == "Telemetry");

        const string body = """
            {"capturedAt":"2026-03-04T05:06:07Z","latitude":51.5,"live":true,"fee":"12.50","token":"3f2504e0-4f89-11d3-9a0c-0305e82c3301"}
            """;
        var value = JsonSerializer.Deserialize(body, telemetry)!;
        Assert.Equal(51.5, telemetry.GetProperty("Latitude")!.GetValue(value));
        Assert.Equal(DateTimeOffset.Parse("2026-03-04T05:06:07Z"), telemetry.GetProperty("CapturedAt")!.GetValue(value));
        Assert.Null(telemetry.GetProperty("TempC")!.GetValue(value));

        var wire = JsonDocument.Parse(JsonSerializer.Serialize(value, telemetry)).RootElement;
        Assert.Equal(51.5, wire.GetProperty("latitude").GetDouble());
        Assert.Equal(DateTimeOffset.Parse("2026-03-04T05:06:07Z"), wire.GetProperty("capturedAt").GetDateTimeOffset());
        Assert.True(wire.GetProperty("live").GetBoolean());
        if (nulls == NullMemberForm.Omit)
        {
            Assert.False(wire.TryGetProperty("tempC", out _));
            Assert.False(wire.TryGetProperty("note", out _));
            Assert.False(wire.TryGetProperty("tags", out _));
        }
        else
        {
            Assert.Equal(JsonValueKind.Null, wire.GetProperty("tempC").ValueKind);
            Assert.Equal(JsonValueKind.Null, wire.GetProperty("note").ValueKind);
            Assert.Equal(0, wire.GetProperty("tags").GetArrayLength());
        }
    }
}
