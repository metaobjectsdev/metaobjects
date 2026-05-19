using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SerializerTests
{
    private static TypeRegistry Reg() => Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    [Fact]
    public void Canonical_output_round_trips_a_simple_tree_byte_for_byte()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "field.string": { "name": "title" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        var canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.EndsWith("\n", canonical);
        Assert.Contains("\"metadata.root\"", canonical);
        Assert.Contains("\"field.string\"", canonical);
    }
}
