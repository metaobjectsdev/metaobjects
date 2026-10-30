using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityGeneratorEscapeTests
{
    private sealed class Probe : EntityGenerator
    {
        public static string Escape(string s) => EscapeAttrString(s);
    }

    [Fact]
    public void Escapes_what_would_end_the_literal()
    {
        Assert.Equal("a\\\\b\\\"c", Probe.Escape("a\\b\"c"));
        Assert.Equal("l1\\nl2\\r\\t", Probe.Escape("l1\nl2\r\t"));
        Assert.Equal("\\u0001\\u2028\\u0085", Probe.Escape("\u0001" + (char)0x2028 + (char)0x85));
    }

    [Fact]
    public void Leaves_ordinary_text_alone()
    {
        Assert.Equal("^[a-z]+é$", Probe.Escape("^[a-z]+é$"));
    }

    [Fact]
    public void An_escaped_value_survives_a_round_trip_through_the_compiler_literal_rules()
    {
        var original = "line1\nline2\t\"q\"\\ " + (char)0x2029;
        var src = "class C { public const string V = \"" + Probe.Escape(original) + "\"; }";
        var tree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(src);
        Assert.Empty(tree.GetDiagnostics());
        var literal = tree.GetRoot().DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax>().Single();
        Assert.Equal(original, literal.Token.ValueText);
    }
}
