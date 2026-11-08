// The no-restart migrations generator subclasses Npgsql's, so it is emitted only for a project
// whose dialect is Postgres (`.metaobjects/config.json` migrate.dialect, the one dialect setting a
// project declares; GenConfig.Dialect). A project on any other dialect, or one that names none,
// declares @sequenceStart without needing the Npgsql package: it gets no generator and no
// identity start in its model, so a migration can never RESTART, and the run says so.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class IdentityStartDialectTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment", "@sequenceStart": 100 } }
          ] } }
        ] } }
        """;

    private static (List<EmittedFile> Files, List<string> Warnings) Run(string? dialect)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m.json")]);
        Assert.Empty(load.Errors);
        var warnings = new List<string>();
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Warn = warnings.Add,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme", Dialect = dialect },
        };
        return (new DbContextGenerator().Generate(ctx).ToList(), warnings);
    }

    [Fact]
    public void A_postgres_project_gets_the_generator_and_the_start()
    {
        var (files, _) = Run("postgres");
        Assert.Contains(files, f => f.Path == "IdentityStartMigrationsSqlGenerator.g.cs");
        Assert.Contains("Npgsql:IdentitySequenceOptions", files.Single(f => f.Path == "AppDbContext.g.cs").Content);
    }

    [Theory]
    [InlineData("sqlite")]
    [InlineData("mysql")]
    [InlineData(null)]
    public void Any_other_project_needs_no_Npgsql_and_cannot_restart(string? dialect)
    {
        var (files, warnings) = Run(dialect);
        var context = Assert.Single(files).Content;
        Assert.DoesNotContain("Npgsql.EntityFrameworkCore.PostgreSQL.Infrastructure", context);
        Assert.DoesNotContain("Npgsql:IdentitySequenceOptions", context);
        Assert.Contains(warnings, w => w.Contains("@sequenceStart") && w.Contains("migrate.dialect"));
    }
}
