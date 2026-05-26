// FR5a / ADR-0009 — JSONPath builder unit tests.
//
// Canonical form:
//   - Root is `$`.
//   - Identifier-safe keys (^[A-Za-z_][A-Za-z0-9_]*$) use dot: `.foo`.
//   - All other keys use single-quoted bracket: `['my-key']`, `['@attr']`.
//   - Array indices use bracket: `[N]`.

using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class JsonPathTests
{
    [Fact]
    public void Empty_builder_renders_root()
    {
        var b = new JsonPathBuilder();
        Assert.Equal("$", b.ToString());
    }

    [Fact]
    public void Identifier_keys_use_dot_notation()
    {
        var b = new JsonPathBuilder();
        b.PushKey("metadata");
        b.PushKey("root");
        Assert.Equal("$.metadata.root", b.ToString());
    }

    [Fact]
    public void Non_identifier_keys_use_bracket_quoted_form()
    {
        var b = new JsonPathBuilder();
        b.PushKey("metadata");
        b.PushKey("root");
        b.PushKey("children");
        b.PushIndex(0);
        b.PushKey("my-package");
        Assert.Equal("$.metadata.root.children[0]['my-package']", b.ToString());
    }

    [Fact]
    public void Attr_prefixed_keys_use_bracket_quoted_form()
    {
        var b = new JsonPathBuilder();
        b.PushKey("metadata");
        b.PushKey("root");
        b.PushKey("@values");
        Assert.Equal("$.metadata.root['@values']", b.ToString());
    }

    [Fact]
    public void Array_indices_use_bracket_form()
    {
        var b = new JsonPathBuilder();
        b.PushKey("root");
        b.PushKey("children");
        b.PushIndex(0);
        b.PushKey("object.entity");
        b.PushKey("children");
        b.PushIndex(1);
        b.PushKey("field.enum");
        Assert.Equal("$.root.children[0]['object.entity'].children[1]['field.enum']", b.ToString());
    }

    [Fact]
    public void Pop_returns_to_previous_path()
    {
        var b = new JsonPathBuilder();
        b.PushKey("metadata");
        b.PushKey("root");
        b.PushKey("children");
        b.PushIndex(0);
        Assert.Equal("$.metadata.root.children[0]", b.ToString());
        b.Pop();
        Assert.Equal("$.metadata.root.children", b.ToString());
        b.Pop();
        Assert.Equal("$.metadata.root", b.ToString());
    }

    [Fact]
    public void Empty_string_key_uses_bracket_quoted_form()
    {
        var b = new JsonPathBuilder();
        b.PushKey("");
        // Empty string fails identifier regex → bracket form.
        Assert.Equal("$['']", b.ToString());
    }

    [Fact]
    public void Keys_with_single_quotes_are_escaped()
    {
        var b = new JsonPathBuilder();
        b.PushKey("it's-a-trap");
        Assert.Equal("$['it\\'s-a-trap']", b.ToString());
    }

    [Fact]
    public void Key_starting_with_digit_uses_bracket_form()
    {
        var b = new JsonPathBuilder();
        b.PushKey("1invalid");
        Assert.Equal("$['1invalid']", b.ToString());
    }

    [Fact]
    public void Deep_nested_path_for_field_enum_values()
    {
        // Mirrors the example in ADR-0009 §Decision (per-segment quoting).
        var b = new JsonPathBuilder();
        b.PushKey("root");
        b.PushKey("children");
        b.PushIndex(0);
        b.PushKey("object.entity");
        b.PushKey("children");
        b.PushIndex(1);
        b.PushKey("field.enum");
        b.PushKey("@values");
        Assert.Equal(
            "$.root.children[0]['object.entity'].children[1]['field.enum']['@values']",
            b.ToString());
    }

    [Fact]
    public void SegmentForKey_renders_single_segment()
    {
        Assert.Equal(".foo", JsonPath.SegmentForKey("foo"));
        Assert.Equal("['my-key']", JsonPath.SegmentForKey("my-key"));
        Assert.Equal("['@attr']", JsonPath.SegmentForKey("@attr"));
    }

    [Fact]
    public void SegmentForIndex_renders_zero_based_indices()
    {
        Assert.Equal("[0]", JsonPath.SegmentForIndex(0));
        Assert.Equal("[42]", JsonPath.SegmentForIndex(42));
    }
}
