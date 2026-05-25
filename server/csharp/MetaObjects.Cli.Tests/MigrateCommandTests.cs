using MetaObjects.Cli;
using MetaObjects.Codegen.Migrate;
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
        { "source.rdb": { "@table": "subscribers" } },
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
        // Full-CREATE now routes through the engine, so the shape matches PostgresEmit:
        // quoted idents, UPPERCASE types, named "{table}_pkey" PK constraint. That's the
        // shape introspection (via --from-db) will see, so a subsequent diff is clean.
        var outcome = MigrateCommand.Run(MetaDir, OutFile);
        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.True(File.Exists(OutFile));
        var sql = File.ReadAllText(OutFile);
        Assert.Contains("CREATE TABLE \"subscribers\" (", sql);
        Assert.Contains("\"email\" TEXT NOT NULL", sql);
        Assert.Contains("CONSTRAINT \"subscribers_pkey\" PRIMARY KEY (\"id\")", sql);
    }

    [Fact]
    public async Task Incremental_migrate_against_an_empty_db_emits_all_creates()
    {
        // Empty actual DB: every expected table becomes a CREATE TABLE in the up
        // migration. The down should drop the just-created table.
        var db = new InlineEmptyDb();
        var upFile = Path.Combine(_tmp, "up.sql");
        var downFile = Path.Combine(_tmp, "down.sql");

        var outcome = await MigrateCommand.RunIncrementalAsync(MetaDir, db, upFile, downFile);

        Assert.True(outcome.Ok, "expected clean run, got: " + string.Join("; ", outcome.Blocked));
        Assert.True(File.Exists(upFile));
        Assert.True(File.Exists(downFile));
        var up = File.ReadAllText(upFile);
        var down = File.ReadAllText(downFile);
        // Engine emits quoted identifiers + CONSTRAINT "{table}_pkey" (PostgresEmit shape).
        Assert.Contains("CREATE TABLE \"subscribers\" (", up);
        Assert.Contains("CONSTRAINT \"subscribers_pkey\" PRIMARY KEY (\"id\")", up);
        Assert.Contains("DROP TABLE \"subscribers\";", down);
    }
}

/// <summary>Inline fake <see cref="IPgIntrospector"/> that returns no rows — the
/// "empty database" baseline used by the incremental-migrate test.</summary>
internal sealed class InlineEmptyDb : IPgIntrospector
{
    public Task<IReadOnlyList<PgRow>> QueryAsync(string sql, params (string Name, object? Value)[] parameters) =>
        Task.FromResult<IReadOnlyList<PgRow>>([]);
}
