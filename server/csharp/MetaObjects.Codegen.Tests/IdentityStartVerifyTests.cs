// `verify --codegen` regenerates with the dialect `gen` read from `.metaobjects/config.json`: a
// Postgres project's identity start and its design-time services are what gen wrote, not drift.
using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Codegen.Tests;

[Collection("Console")]
public sealed class IdentityStartVerifyTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-start-verify-" + Guid.NewGuid().ToString("N"));
    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");

    public IdentityStartVerifyTests()
    {
        Directory.CreateDirectory(Meta);
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), """{ "schema_version": 1, "migrate": { "dialect": "postgres" } }""");
        File.WriteAllText(Path.Combine(Meta, "meta.acme.json"), """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment", "@sequenceStart": 100 } }
          ]}}
        ]}}
        """);
    }

    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private (int Code, string Text) Run(params string[] args)
    {
        var (prevOut, prevErr) = (Console.Out, Console.Error);
        var (o, e) = (new StringWriter(), new StringWriter());
        Console.SetOut(o);
        Console.SetError(e);
        try { return (CodegenCli.Run(args, [new DbContextGenerator()]), o + "\n" + e); }
        finally { Console.SetOut(prevOut); Console.SetError(prevErr); }
    }

    [Fact]
    public void Verify_reads_the_dialect_gen_read()
    {
        var cwd = Directory.GetCurrentDirectory();
        Directory.SetCurrentDirectory(_root);
        try
        {
            var (gen, genText) = Run("gen", Meta, "--out", Out, "--namespace", "Acme.Generated");
            Assert.True(gen == 0, genText);
            Assert.True(File.Exists(Path.Combine(Out, "AppDbContextIdentityStartDesignTimeServices.g.cs")), genText);
            var (verify, verifyText) = Run("verify", "--codegen", Meta, "--out", Out, "--namespace", "Acme.Generated");
            Assert.True(verify == 0, verifyText);
        }
        finally
        {
            Directory.SetCurrentDirectory(cwd);
        }
    }
}
