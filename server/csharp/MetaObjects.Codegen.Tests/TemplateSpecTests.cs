using System;
using System.Linq;
using System.Text.Json;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TemplateSpecTests
{
    private static JsonElement Json(string s) => JsonDocument.Parse(s).RootElement;

    private const string Valid = """
    { "generators": [
      { "name": "svc", "template": "service/entity", "scope": "perEntity", "outputPattern": "{name}.cs" },
      { "name": "reg", "template": "app/registry", "scope": "perModel", "outputPattern": "Registry.cs", "format": "text" }
    ] }
    """;

    [Fact]
    public void AcceptsValidSpec()
    {
        var spec = TemplateSpec.Parse(Json(Valid));
        Assert.Equal(2, spec.Count);
        Assert.Equal("perEntity", spec[0].Scope);
        Assert.Equal("text", spec[1].Format);
    }

    [Fact]
    public void RejectsUnknownScope() =>
        Assert.Throws<ArgumentException>(() => TemplateSpec.Parse(Json(
            """{ "generators": [ { "name": "x", "template": "t", "scope": "perThing", "outputPattern": "x" } ] }""")));

    [Fact]
    public void RejectsMissingRequiredField() =>
        Assert.Throws<ArgumentException>(() => TemplateSpec.Parse(Json(
            """{ "generators": [ { "name": "x", "template": "t", "scope": "perModel" } ] }""")));

    [Fact]
    public void RejectsBadFormat() =>
        Assert.Throws<ArgumentException>(() => TemplateSpec.Parse(Json(
            """{ "generators": [ { "name": "x", "template": "t", "scope": "perModel", "outputPattern": "x", "format": "xml-typo" } ] }""")));

    [Fact]
    public void RejectsTarget() =>
        Assert.Throws<ArgumentException>(() => TemplateSpec.Parse(Json(
            """{ "generators": [ { "name": "x", "template": "t", "scope": "perModel", "outputPattern": "x", "target": "web" } ] }""")));

    [Fact]
    public void RejectsNonObject() =>
        Assert.Throws<ArgumentException>(() => TemplateSpec.Parse(Json("[]")));

    [Fact]
    public void ToGeneratorsNames()
    {
        var provider = new InMemoryProvider(new System.Collections.Generic.Dictionary<string, string>
        {
            ["service/entity"] = "", ["app/registry"] = "",
        });
        var gens = TemplateSpec.ToGenerators(TemplateSpec.Parse(Json(Valid)), provider);
        Assert.Equal(new[] { "svc", "reg" }, gens.Select(g => g.Name));
    }

    [Fact]
    public void ScopeWalkUnknownScopeThrows() =>
        Assert.Throws<ArgumentException>(() => ScopeWalk.ForScope("bogus", "{name}.txt"));
}
