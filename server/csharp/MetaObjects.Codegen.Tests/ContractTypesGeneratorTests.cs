// ADR-0067 layer 1 for writes: the contract-types generator's create and update records.
//
// The expectations come from the write contract the generated routes already serve and ADR-0066,
// not from the generator: a create body never carries what the server owns (a generated key, an
// @autoSet stamp, a readOnly or derived field), a required member with no @default must be sent,
// the update body never carries a key, and a PATCH tells an omitted member (untouched) from an
// explicit null (cleared) and refuses null on a required member. The lifecycle field stays on the
// update record so the service can refuse it with 409 state_managed (ADR-0066 §6).
//
// Each test compiles the emitted entity and contract files with Roslyn, then binds real JSON with
// System.Text.Json and validates with the DataAnnotations Validator, so what is checked is what a
// consumer's endpoint would see.

using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ContractTypesGeneratorTests
{
    private const string Ns = "Acme.Orders";

    private const string Model = """
    { "metadata.root": { "package": "acme::orders", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "city", "@required": true } } ] } },
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
        { "field.string": { "name": "title", "@required": true, "@maxLength": 20 } },
        { "field.string": { "name": "note" } },
        { "field.int": { "name": "quantity", "@required": true, "children": [
          { "validator.numeric": { "@min": 1, "@max": 99 } } ] } },
        { "field.string": { "name": "channel", "@required": true, "@default": "web" } },
        { "field.string": { "name": "tags", "isArray": true } },
        { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
        { "field.string": { "name": "legacyCode", "@mutability": "readOnly" } },
        { "field.enum": { "name": "status", "@values": ["open", "closed"], "@default": "open", "children": [
          { "transition.action": { "name": "close", "@from": ["open"], "@to": "closed" } } ] } }
      ] } },
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.string": { "name": "code", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": ["code"] } },
        { "field.string": { "name": "label" } } ] } }
    ] } }
    """;

    // The application's options: web defaults plus the string enum converter every generated
    // server registers (ConfigureHttpJsonOptions), as the entity itself is bound.
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    private static List<EmittedFile> Emit()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "orders.json")]);
        Assert.True(r.Errors.Count == 0, string.Join("\n", r.Errors.Select(e => $"{e.Code}: {e.Message}")));
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = Ns },
        };
        return new IGenerator[] { new EntityGenerator(), new ContractTypesGenerator() }.SelectMany(g => g.Generate(ctx)).ToList();
    }

    private static readonly Lazy<Assembly> Asm = new(() =>
    {
        var trees = Emit().Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path));
        var comp = CSharpCompilation.Create("contract_types_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var result = comp.Emit(ms);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}")));
        return Assembly.Load(ms.ToArray());
    });

    private static Type T(string name) => Asm.Value.GetType($"{Ns}.{name}") ?? throw new Xunit.Sdk.XunitException($"no type {Ns}.{name}");

    private static string[] WireNames(Type t) =>
        t.GetProperties().Select(p => p.GetCustomAttribute<System.Text.Json.Serialization.JsonPropertyNameAttribute>()?.Name)
            .OfType<string>().ToArray();

    private static object Create(string json) => JsonSerializer.Deserialize(json, T("OrderCreate"), Web)!;

    private static object Update(string json) =>
        T("OrderUpdate").GetMethod("From")!.Invoke(null, [JsonDocument.Parse(json).RootElement, Web])!;

    private static List<string> Errors(object instance)
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(instance, new ValidationContext(instance), results, validateAllProperties: true);
        return results.SelectMany(r => r.MemberNames).ToList();
    }

    private static object? Get(object o, string prop) => o.GetType().GetProperty(prop)!.GetValue(o);

    [Fact]
    public void The_create_record_carries_what_a_client_sends_and_nothing_the_server_owns()
    {
        // Generated key, @autoSet stamp and readOnly field are the server's; the lifecycle field stays.
        Assert.Equal(["title", "note", "quantity", "channel", "tags", "shipTo", "status"], WireNames(T("OrderCreate")));
        // A key the client chooses (no @generation) is part of the create body.
        Assert.Equal(["code", "label"], WireNames(T("TagCreate")));
    }

    [Fact]
    public void The_update_record_never_carries_a_key()
    {
        Assert.Equal(["title", "note", "quantity", "channel", "tags", "shipTo", "status"], WireNames(T("OrderUpdate")));
        Assert.Equal(["label"], WireNames(T("TagUpdate")));
    }

    [Fact]
    public void A_create_without_a_required_member_is_refused_unless_it_has_a_default()
    {
        // title and quantity are required with no default; channel is required but defaults.
        var ex = Assert.ThrowsAny<JsonException>(() => Create("""{"quantity": 2}"""));
        Assert.Contains("title", ex.Message);
        Assert.ThrowsAny<JsonException>(() => Create("""{"title": "a"}"""));

        var ok = Create("""{"title": "a", "quantity": 2}""");
        Assert.Empty(Errors(ok));
        Assert.Null(Get(ok, "Channel"));
    }

    [Fact]
    public void A_create_is_validated_like_the_entity()
    {
        // @maxLength 20 and validator.numeric 1..99, the bounds the entity enforces.
        Assert.Contains("Title", Errors(Create("""{"title": "this title is far too long", "quantity": 2}""")));
        Assert.Contains("Quantity", Errors(Create("""{"title": "a", "quantity": 100}""")));
        Assert.Contains("Title", Errors(Create("""{"title": "", "quantity": 2}""")));
    }

    [Fact]
    public void A_create_binds_enums_value_objects_and_arrays_as_the_entity_types()
    {
        var c = Create("""{"title": "a", "quantity": 2, "status": "closed", "tags": ["x", "y"], "shipTo": {"city": "Oslo"}}""");
        Assert.Equal("closed", Get(c, "Status")!.ToString());
        Assert.Equal(T("Order").GetNestedTypes().Single(t => t.IsEnum), Nullable.GetUnderlyingType(c.GetType().GetProperty("Status")!.PropertyType));
        Assert.Equal(T("Address"), c.GetType().GetProperty("ShipTo")!.PropertyType);
        Assert.Equal(["x", "y"], ((IEnumerable<string>)Get(c, "Tags")!).ToArray());
    }

    [Fact]
    public void An_update_tells_an_omitted_member_from_an_explicit_null()
    {
        var u = Update("""{"note": null, "quantity": 3}""");
        var has = u.GetType().GetMethod("Has")!;
        Assert.True((bool)has.Invoke(u, ["note"])!);
        Assert.True((bool)has.Invoke(u, ["quantity"])!);
        Assert.False((bool)has.Invoke(u, ["title"])!);
        Assert.Null(Get(u, "Note"));
        Assert.Equal(3, Get(u, "Quantity"));
        Assert.Empty(Errors(u));

        // An unknown key and a key are not members, so Has never reports them.
        var other = Update("""{"id": 5, "bogus": 1}""");
        Assert.False((bool)has.Invoke(other, ["id"])!);
        Assert.Empty((IEnumerable<string>)Get(other, "Present")!);
    }

    [Fact]
    public void An_update_cannot_clear_a_required_member_and_is_validated_when_it_sends_one()
    {
        Assert.Contains("Title", Errors(Update("""{"title": null}""")));
        Assert.Contains("Title", Errors(Update("""{"title": ""}""")));
        Assert.Contains("Quantity", Errors(Update("""{"quantity": 0}""")));
        // An optional member may be cleared.
        Assert.Empty(Errors(Update("""{"note": null, "tags": null}""")));
    }

    [Fact]
    public void An_update_keeps_the_lifecycle_field_so_the_service_can_refuse_it()
    {
        var u = Update("""{"status": "closed"}""");
        Assert.True((bool)u.GetType().GetMethod("Has")!.Invoke(u, ["status"])!);
        Assert.Equal("closed", Get(u, "Status")!.ToString());
    }

    [Fact]
    public void A_projection_and_a_value_object_get_no_records()
    {
        var paths = Emit().Select(f => f.Path).ToList();
        Assert.Contains("OrderContracts.g.cs", paths);
        Assert.Contains("TagContracts.g.cs", paths);
        Assert.DoesNotContain("AddressContracts.g.cs", paths);
    }
}
