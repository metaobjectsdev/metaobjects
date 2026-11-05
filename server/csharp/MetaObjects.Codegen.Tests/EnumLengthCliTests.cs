// A member longer than the project's enums.maxLength is a metadata/config defect: `dotnet meta
// gen` and `verify --codegen` report it by name and fail, the way TypeScript's `meta gen` does,
// never as an unhandled exception and a stack trace.
using MetaObjects.Codegen.Generators;
using Xunit;

namespace MetaObjects.Codegen.Tests;

[Collection("Console")]
public sealed class EnumLengthCliTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-enum-cli-" + Guid.NewGuid().ToString("N"));
    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");

    public EnumLengthCliTests()
    {
        Directory.CreateDirectory(Meta);
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), """{ "schema_version": 1, "enums": { "maxLength": 4 } }""");
        File.WriteAllText(Path.Combine(Meta, "meta.acme.json"), """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["OPEN", "CLOSED"] } },
            { "identity.primary": { "@fields": "id" } }
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
    public void Gen_reports_the_member_by_name_and_fails()
    {
        var (code, text) = Run("gen", Meta, "--out", Out, "--namespace", "Acme.Generated");
        Assert.NotEqual(0, code);
        Assert.Contains("field.enum \"Ticket.status\" has the member \"CLOSED\"", text);
    }

    [Fact]
    public void Verify_codegen_reports_the_member_by_name_and_fails()
    {
        var (code, text) = Run("verify", "--codegen", Meta, "--out", Out, "--namespace", "Acme.Generated");
        Assert.NotEqual(0, code);
        Assert.Contains("field.enum \"Ticket.status\" has the member \"CLOSED\"", text);
    }
}
