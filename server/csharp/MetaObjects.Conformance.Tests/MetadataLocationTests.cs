// MetadataLocation is the one metadata ladder `dotnet meta` and an ejected
// codegen/Program.cs share. These pin the two behaviours the owned runner lacked while the
// ladder lived only in the CLI: `libraries` is read for an explicit directory, and a
// ladder-resolved load carries it.

using System.IO;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class MetadataLocationTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "metadata-location-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_root, "metaobjects");

    // References into the `iam` library: loads only when `libraries` reaches the loader.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.uuid": { "name": "id" } },
        { "field.uuid": { "name": "ownerId" } },
        { "identity.primary": { "name": "pk", "@fields": "id" } },
        { "identity.reference": { "name": "ownerRef", "@fields": "ownerId", "@references": "metaobjects::iam::User" } }
      ]}}
    ]}}
    """;

    public MetadataLocationTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Model);
    }

    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private void WriteConfig(string json) =>
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), json);

    [Fact]
    public void An_explicit_directory_still_reads_the_projects_libraries()
    {
        WriteConfig("""{ "schema_version": 1, "sources": [], "libraries": ["iam", "iam/db"] }""");

        var meta = MetadataLocation.Resolve(MetaDir, cwd: Path.GetTempPath());

        Assert.Equal(["iam", "iam/db"], meta.Libraries);
        Assert.Empty(meta.Load().Errors);
    }

    [Fact]
    public void The_ladder_resolves_from_cwd_and_loads_with_libraries()
    {
        WriteConfig("""{ "schema_version": 1, "sources": [], "libraries": ["iam", "iam/db"] }""");

        var meta = MetadataLocation.Resolve(null, cwd: _root);

        Assert.NotNull(meta.Files);
        Assert.Empty(meta.Load().Errors);
    }

    [Fact]
    public void Without_the_library_the_same_model_does_not_load()
    {
        WriteConfig("""{ "schema_version": 1, "sources": [] }""");

        var meta = MetadataLocation.Resolve(MetaDir, cwd: _root);

        Assert.NotEmpty(meta.Load().Errors);
    }

    [Fact]
    public void Several_declared_sources_are_refused_in_words()
    {
        Directory.CreateDirectory(Path.Combine(_root, "more"));
        WriteConfig("""{ "schema_version": 1, "sources": [ { "path": "metaobjects" }, { "path": "more" } ] }""");

        var ex = Assert.Throws<MetadataLocationException>(() => MetadataLocation.Resolve(null, cwd: _root));
        Assert.Contains("2 metadata sources", ex.Message);
    }
}
