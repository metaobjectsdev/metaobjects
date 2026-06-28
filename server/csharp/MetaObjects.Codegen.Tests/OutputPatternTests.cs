using System;
using MetaObjects.Codegen.TemplateCodegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class OutputPatternTests
{
    [Fact]
    public void NameAndPackage() =>
        Assert.Equal("acme/sales/orderService.cs",
            OutputPattern.Expand("{package}/{name}Service.cs", "order", "acme::sales"));

    [Fact]
    public void PascalName() =>
        Assert.Equal("OrderLine.cs", OutputPattern.Expand("{Name}.cs", "order_line", null));

    [Fact]
    public void LiteralPassthrough() =>
        Assert.Equal("registry.cs", OutputPattern.Expand("registry.cs", null, null));

    [Fact]
    public void EmptyPackageCollapses() =>
        Assert.Equal("x.cs", OutputPattern.Expand("{package}/{name}.cs", "x", ""));

    [Fact]
    public void UnknownPlaceholderThrows() =>
        Assert.Throws<ArgumentException>(() => OutputPattern.Expand("{bogus}.cs", "x", "p"));

    [Fact]
    public void NameWithoutNameVarThrows() =>
        Assert.Throws<ArgumentException>(() => OutputPattern.Expand("{name}.cs", null, "p"));
}
