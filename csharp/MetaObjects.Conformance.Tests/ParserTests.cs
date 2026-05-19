using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

// NOTE: overlay, intoRoot-merge, strict-mode, and the "unknown child type
// is a collected MetaError, not an exception" paths are exercised by the
// cross-language conformance harness (Task 4.3). These unit tests cover
// parser construction and key desugar paths only.
public class ParserTests
{
    private static TypeRegistry Reg() => Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    [Fact]
    public void Parses_a_single_entity_with_a_field()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "field.string": { "name": "title" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        Assert.Empty(result.Errors);
        var widget = result.Root.OwnChildByName("Widget")!;
        Assert.Equal("object", widget.Type);
        Assert.Equal("entity", widget.SubType);
        Assert.Equal("title", widget.OwnChildren()[0].Name);
    }

    [Fact]
    public void Malformed_json_throws_ParseException_with_ERR_MALFORMED_JSON()
    {
        var ex = Assert.Throws<ParseException>(() =>
            Parser.ParseJson("{ not json", new ParseOptions(Reg())));
        Assert.Equal(ErrorCode.ERR_MALFORMED_JSON, ex.Code);
    }

    [Fact]
    public void Inline_attr_and_stringarray_desugar()
    {
        const string json = """
        { "metadata.root": { "children": [
            { "object.entity": { "name": "W", "children": [
                { "identity.primary": { "name": "pk", "@fields": "id" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        var id = result.Root.OwnChildByName("W")!.OwnChildren()[0];
        Assert.Equal(new[] { "id" }, (IReadOnlyList<string>)id.OwnAttr("fields")!);
    }

    [Fact]
    public void Parser_handles_any_type_a_future_provider_registers()
    {
        var reg = Provider.ComposeRegistry(
            new IMetaDataTypeProvider[] { CoreTypes.CoreTypesProvider, new WidgetProvider() });
        const string json = """
        { "metadata.root": { "children": [ { "widget.fancy": { "name": "W" } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(reg) { DeferSuperResolution = true });
        Assert.Empty(result.Errors);
        Assert.Equal("widget", result.Root.OwnChildByName("W")!.Type);
    }
}

/// <summary>Test-only provider registering a type the core metamodel does not define.</summary>
file sealed class WidgetProvider : IMetaDataTypeProvider
{
    public string Id => "test-widget";
    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];
    public void RegisterTypes(TypeRegistry registry) => registry.Register(new TypeDefinition(
        new TypeId("widget", "fancy"), "test widget", new List<ChildRule>(),
        (id, name) => new MetaObjects.Meta.MetaObject(id, name), new List<AttrSchema>()));
}
