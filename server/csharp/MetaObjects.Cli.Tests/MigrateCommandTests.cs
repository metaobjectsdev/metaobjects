using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>End-to-end `meta migrate`: a metadata dir -> a Postgres schema .sql file.</summary>
public sealed class MigrateCommandTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-migrate-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutFile => Path.Combine(_tmp, "schema.sql");

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

    public MigrateCommandTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Migrate_writes_postgres_ddl()
    {
        var outcome = MigrateCommand.Run(MetaDir, OutFile);
        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.True(File.Exists(OutFile));
        var sql = File.ReadAllText(OutFile);
        Assert.Contains("CREATE TABLE subscribers (", sql);
        Assert.Contains("email text NOT NULL", sql);
        Assert.Contains("PRIMARY KEY (id)", sql);
    }
}
