using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class FrameworkQualifierTests
{
    private static string Q(string code) => FrameworkQualifier.Qualify(code);

    [Fact]
    public void Code_is_qualified()
    {
        Assert.Equal("var x = global::System.Math.Abs(1); global::Microsoft.X.Y();", Q("var x = System.Math.Abs(1); Microsoft.X.Y();"));
        Assert.Equal("a.System.Foo", Q("a.System.Foo"));
        Assert.Equal("global::System.Text.Json.JsonSerializer.Serialize(1)", Q("global::System.Text.Json.JsonSerializer.Serialize(1)").Replace("global::global::", "global::"));
    }

    [Fact]
    public void Using_and_namespace_lines_are_left_alone()
        => Assert.Equal("using System.Linq;\nnamespace Acme.System;\nvar a = global::System.Int32.MaxValue;",
            Q("using System.Linq;\nnamespace Acme.System;\nvar a = System.Int32.MaxValue;"));

    [Fact]
    public void Global_using_and_preprocessor_lines_are_left_alone()
        => Assert.Equal("global using System.Text;\n#region Don't touch System.X\n#endregion\nvar a = global::System.Int32.MaxValue;",
            Q("global using System.Text;\n#region Don't touch System.X\n#endregion\nvar a = System.Int32.MaxValue;"));

    [Fact]
    public void Line_and_block_comments_are_left_alone()
        => Assert.Equal("// System.Foo\n/* System.Bar\n System.Baz */ global::System.Qux.Z();",
            Q("// System.Foo\n/* System.Bar\n System.Baz */ System.Qux.Z();"));

    [Fact]
    public void A_regular_string_is_left_alone_including_an_escaped_quote()
        => Assert.Equal("var s = \"a \\\" System.Foo\"; global::System.X.Y();", Q("var s = \"a \\\" System.Foo\"; System.X.Y();"));

    [Fact]
    public void A_using_directive_aliasing_a_name_starting_with_var_is_left_alone()
        => Assert.Equal("using variance = System.Collections.Generic.IEnumerable<int>;",
            Q("using variance = System.Collections.Generic.IEnumerable<int>;"));

    [Fact]
    public void A_using_statement_declaring_a_variable_has_its_framework_references_qualified()
        => Assert.Equal("using var r = new global::System.IO.StringReader(s); global::System.X.Y();",
            Q("using var r = new System.IO.StringReader(s); System.X.Y();"));

    [Fact]
    public void A_using_static_directive_is_left_alone()
        => Assert.Equal("using static System.Math;", Q("using static System.Math;"));

    [Fact]
    public void An_explicit_type_using_declaration_is_a_statement_not_a_directive()
        => Assert.Equal("using global::System.IO.StringReader r = new global::System.IO.StringReader(s);",
            Q("using System.IO.StringReader r = new System.IO.StringReader(s);"));

    [Fact]
    public void A_using_statement_with_parentheses_has_its_framework_references_qualified()
        => Assert.Equal("using (global::System.IO.Stream s = global::System.IO.File.OpenRead(p)) { }",
            Q("using (System.IO.Stream s = System.IO.File.OpenRead(p)) { }"));

    [Fact]
    public void A_char_literal_holding_a_quote_does_not_start_a_string()
        => Assert.Equal("var q = '\"'; global::System.X.Y(); var e = '\\'';", Q("var q = '\"'; System.X.Y(); var e = '\\'';"));

    [Fact]
    public void A_verbatim_string_with_doubled_quotes_is_left_alone()
        => Assert.Equal("var s = @\"a \"\" System.Foo\"; global::System.X.Y();", Q("var s = @\"a \"\" System.Foo\"; System.X.Y();"));

    [Fact]
    public void An_interpolated_string_leaves_text_alone_and_qualifies_its_holes()
        => Assert.Equal("var s = $\"System.Foo {global::System.Math.Abs(1)} {{System.Bar}} {(a ? \"System.Z\" : \"b\")}\";",
            Q("var s = $\"System.Foo {System.Math.Abs(1)} {{System.Bar}} {(a ? \"System.Z\" : \"b\")}\";"));

    [Fact]
    public void A_nested_quote_inside_an_interpolation_does_not_end_the_string()
        => Assert.Equal("var s = $\"x {d[\"k\"]} System.Y\"; global::System.A.B();", Q("var s = $\"x {d[\"k\"]} System.Y\"; System.A.B();"));

    [Fact]
    public void A_raw_string_is_left_alone()
        => Assert.Equal("var s = \"\"\"\n  System.Foo \"quoted\" \n  \"\"\"; global::System.A.B();", Q("var s = \"\"\"\n  System.Foo \"quoted\" \n  \"\"\"; System.A.B();"));

    [Fact]
    public void An_empty_string_is_not_a_raw_string()
        => Assert.Equal("var s = \"\"; global::System.A.B();", Q("var s = \"\"; System.A.B();"));
}
