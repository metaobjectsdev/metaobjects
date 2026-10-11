// A MINOR release removes no published public member (docs/compatibility-policy.md): a member that
// moved stays as a forwarder, and a constructor that gained a parameter keeps its old signature.

using MetaObjects.Codegen.ApiDocs;
using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PublishedSurfaceTests
{
    [Fact]
    public void The_1_0_member_Fr010FieldMapping_CSharpStringLiteral_still_answers_as_it_did()
    {
#pragma warning disable CS0618 // the point is to call the obsolete member
        Assert.Equal("a\\\"b\\n", Fr010FieldMapping.CSharpStringLiteral("a\"b\n"));
        Assert.Equal("plain", Fr010FieldMapping.CSharpStringLiteral("plain"));
#pragma warning restore CS0618
        Assert.NotNull(typeof(Fr010FieldMapping).GetMethod(nameof(Fr010FieldMapping.CSharpStringLiteral))!
            .GetCustomAttributes(typeof(ObsoleteAttribute), false).SingleOrDefault());
    }

    [Fact]
    public void The_1_0_CSharpApiModelBuilder_constructor_keeps_its_signature()
    {
        var one = typeof(CSharpApiModelBuilder).GetConstructor([typeof(GenConfig)]);
        Assert.NotNull(one);
        var model = new CSharpApiModelBuilder(new GenConfig { OutDir = "/tmp", Namespace = "Acme" })
            .Build(EjectedGeneratorCompileTests.LoadCorpus(), "fitness");
        Assert.NotEmpty(model.Units);
    }
}
