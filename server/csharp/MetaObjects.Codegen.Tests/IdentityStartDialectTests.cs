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

    private static (List<EmittedFile> Files, List<string> Warnings) Run(string? dialect, string model = Model)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
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
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("Npgsql:IdentitySequenceOptions", context);
        // Wired at registration (UseIdentityStartMigrations), never by the context's OnConfiguring:
        // that fails under pooling, collides with a partial context's own, and shadows a base's.
        Assert.DoesNotContain("OnConfiguring", context);
        Assert.Contains("global::Acme.IdentityStartMigrations.EnsureConfigured(this);", context);
        Assert.Contains("public static DbContextOptionsBuilder UseIdentityStartMigrations(this DbContextOptionsBuilder options)",
            files.Single(f => f.Path == "IdentityStartMigrationsSqlGenerator.g.cs").Content);
    }

    [Fact]
    public void A_postgres_project_without_a_start_still_gets_the_rewrite_so_removing_one_cannot_restart()
    {
        // Removing the last @sequenceStart is a start-only change (Npgsql: RESTART WITH 1), and the
        // adopter's UseIdentityStartMigrations() call must keep compiling.
        var (files, warnings) = Run("postgres", Model.Replace(", \"@sequenceStart\": 100", ""));
        Assert.Contains(files, f => f.Path == "IdentityStartMigrationsSqlGenerator.g.cs");
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.DoesNotContain("EnsureConfigured", context);
        Assert.DoesNotContain("Npgsql:IdentitySequenceOptions", context);
        Assert.Empty(warnings);
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
        Assert.Contains(warnings, w => w.Contains("@sequenceStart") && w.Contains("migrate.dialect") && w.Contains("GenConfig.Dialect"));
    }
}
