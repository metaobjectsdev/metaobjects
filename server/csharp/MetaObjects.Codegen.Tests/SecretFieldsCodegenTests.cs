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

    // A TPH base whose subtypes share the token and memo columns: plain on AThing, marked on BThing.
    private const string TphSharedColumnModel = """
    { "metadata.root": { "package": "acme::secrets", "children": [
      { "object.entity": { "name": "Thing", "@discriminator": "kind", "children": [
        { "source.rdb":       { "@table": "things" } },
        { "field.long":       { "name": "id" } },
        { "field.enum":       { "name": "kind", "@values": ["A", "B"] } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "AThing", "extends": "Thing", "@discriminatorValue": "A", "children": [
        { "field.string": { "name": "token", "@maxLength": 100 } },
        { "field.string": { "name": "memo", "@maxLength": 100 } }
      ]}},
      { "object.entity": { "name": "BThing", "extends": "Thing", "@discriminatorValue": "B", "children": [
        { "field.string": { "name": "token", "@maxLength": 100, "children": [ { "view.password": {} } ] } },
        { "field.string": { "name": "memo", "@maxLength": 100, "@formExclude": true } }
      ]}}
    ]}}
    """;

    private static string Routes(string model, string file = "AccountRoutes.g.cs")
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "secrets.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
        return new RoutesGenerator().Generate(ctx).Single(f => f.Path == file).Content;
    }

    [Fact]
    public void A_tph_column_marked_on_another_subtype_is_hidden_and_ignored_on_this_one()
    {
        var src = Routes(TphSharedColumnModel, "ThingRoutes.g.cs");
        var start = src.IndexOf("\"/things/a\"", StringComparison.Ordinal);
        var end = src.IndexOf("\"/things/b\"", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, src);
        var aRoutes = src[start..end];

        Assert.Contains("new string[] { \"token\" }", aRoutes);
        Assert.Contains("input.Token = default!;", aRoutes);
        Assert.Contains("input.Memo = default!;", aRoutes);
        Assert.Contains("string.Equals(prop.Name, \"token\", System.StringComparison.OrdinalIgnoreCase)) continue;", aRoutes);
        Assert.Contains("string.Equals(prop.Name, \"memo\", System.StringComparison.OrdinalIgnoreCase)) continue;", aRoutes);
        Assert.DoesNotContain("\"memo\" }", aRoutes);
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
