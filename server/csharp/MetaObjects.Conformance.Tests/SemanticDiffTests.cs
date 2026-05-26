// FR5a / ADR-0009 — SemanticDiff smoke tests.
//
// FR5a doesn't exercise SemanticDiff at runtime — FR5c will consume the boolean
// to drive the duplicate-with-no-change WARN_DUPLICATE_DECLARATION path. We
// ship a smoke suite now so the port is ready when FR5c lands.

using System.Text.Json.Nodes;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SemanticDiffTests
{
    private static JsonNode Parse(string json) => JsonNode.Parse(json)!;

    [Fact]
    public void Identical_objects_have_no_diff()
    {
        var a = Parse("""{ "name": "X", "@values": ["A", "B"] }""");
        var b = Parse("""{ "name": "X", "@values": ["A", "B"] }""");
        Assert.False(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Key_order_does_not_matter()
    {
        var a = Parse("""{ "a": 1, "b": 2, "c": 3 }""");
        var b = Parse("""{ "c": 3, "a": 1, "b": 2 }""");
        Assert.False(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Different_attr_values_diff()
    {
        var a = Parse("""{ "name": "X", "@v": 1 }""");
        var b = Parse("""{ "name": "X", "@v": 2 }""");
        Assert.True(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Added_key_diffs()
    {
        var a = Parse("""{ "name": "X" }""");
        var b = Parse("""{ "name": "X", "@v": 1 }""");
        Assert.True(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Children_order_matters()
    {
        var a = Parse("""{ "children": [{ "k": 1 }, { "k": 2 }] }""");
        var b = Parse("""{ "children": [{ "k": 2 }, { "k": 1 }] }""");
        Assert.True(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Source_field_is_excluded_from_diff()
    {
        // ADR-0009 §semantic_diff.4: `source` is loader output, never participates.
        var a = Parse("""{ "name": "X", "source": { "format": "json", "files": ["a.json"], "jsonPath": "$" } }""");
        var b = Parse("""{ "name": "X", "source": { "format": "code" } }""");
        Assert.False(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Nested_object_difference_diffs()
    {
        var a = Parse("""{ "outer": { "inner": 1 } }""");
        var b = Parse("""{ "outer": { "inner": 2 } }""");
        Assert.True(SemanticDiff.Diff(a, b));
    }

    [Fact]
    public void Null_versus_value_diffs()
    {
        var a = Parse("""{ "k": null }""");
        var b = Parse("""{ "k": 0 }""");
        Assert.True(SemanticDiff.Diff(a, b));
    }
}
