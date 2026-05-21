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

    [Fact]
    public void Canonical_output_matches_loader_basic_single_entity_fixture()
    {
        // Locate the corpus by walking up from AppContext.BaseDirectory until we find fixtures/conformance/
        string root = System.AppContext.BaseDirectory;
        while (!System.IO.Directory.Exists(System.IO.Path.Combine(root, "fixtures", "conformance")))
        {
            var parent = System.IO.Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new System.InvalidOperationException("fixtures/conformance not found walking up from " + System.AppContext.BaseDirectory);
            root = parent;
        }
        var fixtureDir = System.IO.Path.Combine(root, "fixtures", "conformance", "loader-basic-single-entity");
        var inputFile = System.IO.Directory.GetFiles(System.IO.Path.Combine(fixtureDir, "input"), "*.json")[0];

        var result = Parser.ParseJson(System.IO.File.ReadAllText(inputFile),
            new ParseOptions(Reg()) { DeferSuperResolution = true });
        Assert.Empty(result.Errors);

        var actual = SerializerJson.CanonicalSerialize(result.Root);
        var expected = System.IO.File.ReadAllText(System.IO.Path.Combine(fixtureDir, "expected.json"));

        // Normalize line endings just in case CRLF crept in from a checkout; the
        // canonical output uses LF and the corpus is LF in the repo.
        Assert.Equal(expected.Replace("\r\n", "\n"), actual);
    }
}
