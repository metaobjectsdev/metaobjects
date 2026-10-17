using MetaObjects.Codegen.TemplateCodegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

[Collection("Console")]
public sealed class WrappedTemplateSpecTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-wrapped-spec-" + Guid.NewGuid().ToString("N"));
    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");
    private string Spec => Path.Combine(_root, "template-spec.json");

    public WrappedTemplateSpecTests()
    {
        Directory.CreateDirectory(Meta);
        File.WriteAllText(Path.Combine(Meta, "meta.acme.json"),
            """{ "metadata.root": { "package": "acme", "children": [] } }""");
    }

    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private IReadOnlyList<IGenerator> Suite() =>
        [new TemplateSpecGenerator { Spec = Spec }.WithHandEdits(HandEdits.Overwrite)];

    private (int Code, string Err) Run(params string[] args)
    {
        var prevErr = Console.Error;
        var (o, e) = (new StringWriter(), new StringWriter());
        var prevOut = Console.Out;
        Console.SetOut(o);
        Console.SetError(e);
        try { return (CodegenCli.Run(args, Suite()), e.ToString()); }
        finally { Console.SetOut(prevOut); Console.SetError(prevErr); }
    }

    [Fact]
    public void A_wrapped_declared_spec_is_not_legacy_and_an_invalid_one_is_validated_by_gen()
    {
        File.WriteAllText(Spec, "{ not json");
        var gen = Run("gen", Meta, "--out", Out);
        Assert.DoesNotContain("1.0 template-spec configuration", gen.Err);
        Assert.Equal(1, gen.Code);
        Assert.Contains("template spec", gen.Err);
    }

    [Fact]
    public void A_wrapped_declared_spec_is_not_legacy_and_an_invalid_one_is_validated_by_verify()
    {
        File.WriteAllText(Spec, "{ not json");
        var verify = Run("verify", "--codegen", Meta, "--out", Out);
        Assert.DoesNotContain("1.0 template-spec configuration", verify.Err);
        Assert.Contains("template spec", verify.Err);
    }
}
