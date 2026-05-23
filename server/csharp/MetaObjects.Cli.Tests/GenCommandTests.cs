using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>End-to-end `meta gen`: a metadata dir -> generated EF Core files on disk.</summary>
public sealed class GenCommandTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-gen-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.dbTable": { "@name": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public GenCommandTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Gen_writes_entity_and_dbcontext()
    {
        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated");
        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.True(File.Exists(Path.Combine(OutDir, "Subscriber.g.cs")));
        Assert.True(File.Exists(Path.Combine(OutDir, "AppDbContext.g.cs")));
        Assert.Contains("public class Subscriber", File.ReadAllText(Path.Combine(OutDir, "Subscriber.g.cs")));
        Assert.Contains(outcome.Result!.Files, f => f.Status == "written");
    }
}
