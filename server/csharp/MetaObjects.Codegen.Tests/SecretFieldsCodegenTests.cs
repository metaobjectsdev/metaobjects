// SecretFieldsCodegenTests — #484: the generated routes ignore a write-denied key (@formExclude
// or a credential) and never send a credential. The HTTP behaviour is gated by the api-contract
// secret-fields corpus; this pins the emission, including the one thing HTTP cannot observe: a
// credential's write path names it exactly as an @formExclude field's.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class SecretFieldsCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::secrets", "children": [
      { "object.entity": { "name": "Account", "children": [
        { "source.rdb":       { "@table": "accounts" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "name", "@maxLength": 100 } },
        { "field.string":     { "name": "tokenHash", "@maxLength": 100, "@formExclude": true } },
        { "field.string":     { "name": "pinHash", "@maxLength": 100, "children": [ { "view.password": {} } ] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // The same entity with an INHERITED credential and an inherited @formExclude (ADR-0039).
    private const string InheritedModel = """
    { "metadata.root": { "package": "acme::secrets", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.string": { "name": "tokenHash", "@maxLength": 100, "@formExclude": true } },
        { "field.string": { "name": "pinHash", "@maxLength": 100, "children": [ { "view.password": {} } ] } }
      ]}},
      { "object.entity": { "name": "Account", "children": [
        { "source.rdb":       { "@table": "accounts" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "tokenHash", "extends": "Base.tokenHash" } },
        { "field.string":     { "name": "pinHash", "extends": "Base.pinHash" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private const string PlainModel = """
    { "metadata.root": { "package": "acme::secrets", "children": [
      { "object.entity": { "name": "Account", "children": [
        { "source.rdb":       { "@table": "accounts" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "name", "@maxLength": 100 } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static string Routes(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "secrets.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
        return new RoutesGenerator().Generate(ctx).Single(f => f.Path == "AccountRoutes.g.cs").Content;
    }

    [Theory]
    [InlineData(Model)]
    [InlineData(InheritedModel)]
    public void Write_paths_name_both_denied_fields_and_read_hides_only_the_credential(string model)
    {
        var src = Routes(model);

        // Create resets both; PATCH / PUT skip both (a present null is a write too).
        Assert.Contains("input.TokenHash = default!;", src);
        Assert.Contains("input.PinHash = default!;", src);
        Assert.Contains("string.Equals(prop.Name, \"tokenHash\", System.StringComparison.OrdinalIgnoreCase)) continue;", src);
        Assert.Contains("string.Equals(prop.Name, \"pinHash\", System.StringComparison.OrdinalIgnoreCase)) continue;", src);

        // Only the credential is omitted on read (list, get, create echo, update echo).
        Assert.Contains("new string[] { \"pinHash\" }", src);
        Assert.DoesNotContain("\"tokenHash\" }", src);
        Assert.DoesNotContain("new string[] { \"tokenHash\"", src);
        Assert.DoesNotContain("Results.Ok(rows)", src);
        Assert.DoesNotContain("Results.Ok(found)", src);
        Assert.DoesNotContain("Results.Ok(existing)", src);
        Assert.DoesNotContain("Results.Created(", src);
    }

    [Fact]
    public void A_model_with_neither_mark_is_unchanged()
    {
        var src = Routes(PlainModel);
        Assert.DoesNotContain("CredentialOmittingResult", src);
        Assert.DoesNotContain("default!;", src);
        Assert.DoesNotContain("formExclude", src, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Results.Ok(rows)", src);
        Assert.Contains("Results.Ok(existing)", src);
    }
}
