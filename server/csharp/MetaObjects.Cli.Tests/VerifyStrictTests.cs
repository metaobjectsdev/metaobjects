using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// #96 — `dotnet meta verify` is strict-by-default (ADR-0023), with a `--lax`
/// escape. An undeclared / typo'd own `@attr` is <c>ERR_UNKNOWN_ATTR</c> and verify
/// surfaces it as a load error (non-zero exit); `--lax` restores the legacy
/// open-attr load so the same metadata passes.
///
/// This closes the port-dependent verdict where an unregistered attr silently
/// passed verify in C# (lax load) but was rejected by Java's force-strict Maven
/// goal. The loader-level error code/text is unchanged — only the verify CLI's
/// default strictness moves (and only verify; gen/docs/agent-docs stay lax).
/// </summary>
public sealed class VerifyStrictTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-verify-strict-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string TplDir => Path.Combine(_tmp, "templates");

    // A registered node (object.entity / field.string) carrying ONE made-up own
    // attribute (@madeUpAttr) that no metamodel provider declares. Strict load →
    // ERR_UNKNOWN_ATTR; lax load → accepted.
    private const string MetadataWithUnknownAttr = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@madeUpAttr": "oops" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public VerifyStrictTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(TplDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), MetadataWithUnknownAttr);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private VerifyCommand.Options Opts(bool strict) =>
        new()
        {
            MetadataDir = MetaDir,
            TemplatesRoot = TplDir,
            Templates = true,
            Strict = strict,
        };

    [Fact]
    public void Verify_strict_by_default_rejects_an_unregistered_attr()
    {
        // Default Options.Strict is true → the made-up @attr is ERR_UNKNOWN_ATTR.
        var opts = new VerifyCommand.Options { MetadataDir = MetaDir, TemplatesRoot = TplDir, Templates = true };
        Assert.True(opts.Strict); // strict is the default

        var r = VerifyCommand.RunSubverbs(opts);
        Assert.NotEqual(0, r.ExitCode);
        Assert.NotNull(r.Templates);
        Assert.Contains(ErrorCode.ERR_UNKNOWN_ATTR.ToString(), r.Templates!.LoadErrors);
    }

    [Fact]
    public void Verify_lax_accepts_an_unregistered_attr()
    {
        var r = VerifyCommand.RunSubverbs(Opts(strict: false));
        // No load errors under lax — the made-up attr is tolerated.
        Assert.DoesNotContain(ErrorCode.ERR_UNKNOWN_ATTR.ToString(), r.Templates!.LoadErrors);
        Assert.Empty(r.Templates!.LoadErrors);
    }

    [Fact]
    public void Run_strict_surfaces_unknown_attr_as_a_load_error()
    {
        var strict = VerifyCommand.Run(MetaDir, TplDir, strict: true);
        Assert.Contains(ErrorCode.ERR_UNKNOWN_ATTR.ToString(), strict.LoadErrors);
        Assert.False(strict.Ok);

        var lax = VerifyCommand.Run(MetaDir, TplDir, strict: false);
        Assert.DoesNotContain(ErrorCode.ERR_UNKNOWN_ATTR.ToString(), lax.LoadErrors);
    }

    [Fact]
    public void Codegen_gate_is_strict_by_default_and_reports_the_unknown_attr()
    {
        var opts = new VerifyCommand.Options
        {
            MetadataDir = MetaDir,
            OutDir = Path.Combine(_tmp, "generated"),
            Codegen = true,
            // Strict defaults true.
        };
        var r = VerifyCommand.RunSubverbs(opts);
        // Strict load fails before any diff → codegen error (exit 2), naming the code.
        Assert.NotEqual(0, r.ExitCode);
        Assert.NotNull(r.Codegen!.Error);
        Assert.Contains(ErrorCode.ERR_UNKNOWN_ATTR.ToString(), r.Codegen!.Error);
    }
}
