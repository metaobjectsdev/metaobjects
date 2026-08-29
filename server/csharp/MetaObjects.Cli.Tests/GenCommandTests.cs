using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>End-to-end `dotnet meta gen`: a metadata dir -> generated EF Core files on disk.</summary>
public sealed class GenCommandTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-gen-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
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

    /// <summary>
    /// The hash manifest belongs to the PROJECT — the directory holding
    /// <c>metaobjects/</c> — not to whatever directory the process happens to sit in.
    /// It used to be anchored on <c>Directory.GetCurrentDirectory()</c>, so generating
    /// from anywhere but the project root scattered a stray <c>.metaobjects/</c> into
    /// the caller's cwd and left the real project with no record of what was written —
    /// which is the whole point of committing the manifest. The Python port already
    /// anchors on the metadata dir's parent for exactly this reason.
    /// </summary>
    [Fact]
    public void Gen_writes_the_hash_manifest_beside_the_metadata_not_in_cwd()
    {
        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated");
        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));

        Assert.True(
            File.Exists(Path.Combine(_tmp, ".metaobjects", ".gen-state", ".hashes.json")),
            "expected the manifest beside the project's metaobjects/ dir");
        Assert.False(
            File.Exists(Path.Combine(
                Directory.GetCurrentDirectory(), ".metaobjects", ".gen-state", ".hashes.json")),
            "gen must not scatter .metaobjects/ into the current working directory");
    }
}
