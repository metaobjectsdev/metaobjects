// The C# example generators in docs/recipes/generators/csharp/ are compiled into this test
// project verbatim (see the csproj) and run here through CodegenCli.Run — the exact entry an
// owned codegen/Program.cs calls — so the recipe the docs tell adopters to copy keeps
// compiling, generating and verifying (ADR-0034 Amendment 4). They are examples, not a
// product surface: this pins that they WORK, not what they emit to anyone.

using System.Text.Json.Nodes;
using Codegen.Generators;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

[Collection("Console")]
public class RecipeGeneratorTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-recipe-" + Guid.NewGuid().ToString("N"));

    private const string Model = """
        { "metadata": { "package": "shop", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city", "@required": true } } ]}},
          { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
            { "field.long": { "name": "id" } },
            { "field.timestamp": { "name": "createdAt", "@required": true } },
            { "field.string": { "name": "labels", "isArray": true, "@maxLength": 40 } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ]}},
          { "object.entity": { "name": "Customer", "extends": "BaseEntity", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.string": { "name": "email", "@required": true } },
            { "field.object": { "name": "shipping", "@objectRef": "Address", "@storage": "jsonb" } },
            { "field.enum": { "name": "tier", "@values": ["free", "paid"] } } ]}}
        ]}}
        """;

    public RecipeGeneratorTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "metaobjects"));
        File.WriteAllText(Path.Combine(_root, "metaobjects", "meta.shop.json"), Model);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");
    private static IReadOnlyList<IGenerator> Suite => [new JsonSchemaGenerator(), new OpenApiGenerator("Shop", "/api")];

    [Fact]
    public void The_recipe_generates_verifies_and_catches_drift()
    {
        Assert.Equal(0, CodegenCli.Run(["gen", Meta, "--out", Out], Suite));

        var customer = JsonNode.Parse(File.ReadAllText(Path.Combine(Out, "schemas", "Customer.schema.json")))!;
        // Inherited through `extends`: fields, @required, isArray, @maxLength.
        Assert.Equal("date-time", (string?)customer["properties"]!["createdAt"]!["format"]);
        Assert.Equal("array", (string?)customer["properties"]!["labels"]!["type"]);
        Assert.Equal(40, (int?)customer["properties"]!["labels"]!["items"]!["maxLength"]);
        Assert.Equal("./Address.schema.json", (string?)customer["properties"]!["shipping"]!["$ref"]);
        Assert.Equal(["createdAt", "email"], customer["required"]!.AsArray().Select(n => (string?)n));
        Assert.False(File.Exists(Path.Combine(Out, "schemas", "BaseEntity.schema.json")));

        var api = JsonNode.Parse(File.ReadAllText(Path.Combine(Out, "openapi.json")))!;
        Assert.Equal("3.1.0", (string?)api["openapi"]);
        Assert.Equal(["/api/customers", "/api/customers/{id}"], api["paths"]!.AsObject().Select(p => p.Key));

        Assert.Equal(0, CodegenCli.Run(["verify", "--codegen", Meta, "--out", Out], Suite));

        File.WriteAllText(Path.Combine(Meta, "meta.shop.json"),
            Model.Replace("""{ "field.string": { "name": "email", "@required": true } },""",
                """{ "field.string": { "name": "email", "@required": true } }, { "field.string": { "name": "note" } },"""));
        Assert.NotEqual(0, CodegenCli.Run(["verify", "--codegen", Meta, "--out", Out], Suite));
    }

    private sealed class Throws : IGenerator
    {
        public string Name => "throws";
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => throw new InvalidOperationException("boom in my generator");
    }

    [Fact]
    public void A_generator_that_throws_is_reported_as_the_generator_not_as_the_metadata()
    {
        var err = new StringWriter();
        var prev = Console.Error;
        Console.SetError(err);
        try
        {
            Assert.Equal(1, CodegenCli.Run(["gen", Meta, "--out", Out], [new Throws()]));
        }
        finally
        {
            Console.SetError(prev);
        }
        var text = err.ToString();
        Assert.Contains("boom in my generator", text);
        Assert.Contains("a generator threw", text);
        Assert.DoesNotContain("metadata did not load cleanly", text);
    }
}
