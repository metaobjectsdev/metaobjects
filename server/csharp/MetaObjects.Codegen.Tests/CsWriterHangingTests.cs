using MetaObjects.Codegen.Writer;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>The hanging continuation of <see cref="CsWriter"/>: a statement that carries on one level in.
/// Not a shared-corpus case, because it is a scope rather than a line, so the cases of the other
/// ports have no op to name it by.</summary>
public class CsWriterHangingTests
{
    [Fact]
    public void A_statement_continues_one_level_in_and_returns_to_its_own_level()
    {
        var w = new CsWriter();
        w.Line("public class A");
        using (w.Block("{"))
        {
            w.Line("var x = items");
            using (w.Hanging())
            {
                w.Line(".Where(i => i.Ok)");
                w.Line(".ToList();");
            }
            w.Line("return x;");
        }
        Assert.Equal(
            "public class A\n{\n    var x = items\n        .Where(i => i.Ok)\n        .ToList();\n    return x;\n}\n",
            w.ToString());
    }

    [Fact]
    public void A_continuation_can_hang_inside_another()
    {
        var w = new CsWriter();
        w.Line("a =");
        using (w.Hanging())
        {
            w.Line("b");
            using (w.Hanging()) w.Line("?? c;");
        }
        Assert.Equal("a =\n    b\n        ?? c;\n", w.ToString());
    }

    [Fact]
    public void A_continuation_ended_with_a_block_still_open_inside_it_is_refused()
    {
        var w = new CsWriter();
        w.Line("a =");
        var hang = w.Hanging();
        w.Open("{");
        var e = Assert.Throws<WriterException>(() => hang.Dispose());
        Assert.Equal(WriterErrors.UnbalancedClose, e.Code);
    }
}
