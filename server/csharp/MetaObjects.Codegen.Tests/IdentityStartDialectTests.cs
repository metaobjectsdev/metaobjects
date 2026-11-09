// The identity start is a design-time concern (ruling R50): a start-only change matters only when a
// migration is scaffolded, so a Postgres context with an increment key gets a generated
// IDesignTimeServices that wraps the context's own model differ, and nothing at runtime. The start
// itself reaches the model only for a project whose dialect is Postgres (`.metaobjects/config.json`
// migrate.dialect; GenConfig.Dialect). A project on any other dialect, or one that names none, gets
// no design-time services and no identity start in its model, so a migration can never RESTART,
// and the run says so.

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

    private const string ServicesFile = "AppDbContextDesignTimeServices.g.cs";

    private static (List<EmittedFile> Files, List<string> Warnings) Run(
        string? dialect, string model = Model, string? assembly = "Acme.Data", string outDir = "/unused")
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(load.Errors);
        var warnings = new List<string>();
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Warn = warnings.Add,
            Config = new GenConfig { OutDir = outDir, Namespace = "Acme", Dialect = dialect, ContextAssemblyName = assembly },
        };
        return (new DbContextGenerator().Generate(ctx).ToList(), warnings);
    }

    [Fact]
    public void A_postgres_project_gets_the_design_time_services_and_the_start()
    {
        var (files, warnings) = Run("postgres");
        Assert.Empty(warnings);
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("Npgsql:IdentitySequenceOptions", context);
        // Nothing at runtime: no registration to call, no guard as the model is built.
        Assert.DoesNotContain("EnsureConfigured", context);
        Assert.DoesNotContain("UseIdentityStartMigrations", context);
        Assert.DoesNotContain(files, f => f.Path == "IdentityStartMigrationsSqlGenerator.g.cs");

        var services = files.Single(f => f.Path == ServicesFile).Content;
        Assert.Contains("public sealed class AppDbContextDesignTimeServices : IDesignTimeServices", services);
        Assert.Contains(
            "[assembly: DesignTimeServicesReference(\"Acme.AppDbContextDesignTimeServices, Acme.Data\", \"Npgsql.EntityFrameworkCore.PostgreSQL\")]",
            services);
        // Public EF types only: no Npgsql reference, no EF-internal differ.
        Assert.DoesNotContain("Npgsql.EntityFrameworkCore.PostgreSQL.", services.Replace("\"Npgsql.EntityFrameworkCore.PostgreSQL\"", ""));
        Assert.DoesNotContain(".Internal", services);
        Assert.DoesNotContain("EF1001", services);
        Assert.DoesNotContain("UseIdentityStartMigrations", services);
    }

    [Fact]
    public void The_start_line_is_one_model_statement()
    {
        // One entry per statement: an `if` and its body as two entries split apart when the
        // OnModelCreating body is chunked.
        var context = Run("postgres").Files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        var line = Assert.Single(context.Split('\n'), l => l.Contains("Npgsql:IdentitySequenceOptions"));
        Assert.StartsWith("if (Database.ProviderName == \"Npgsql.EntityFrameworkCore.PostgreSQL\") modelBuilder.Entity<Ticket>()", line.Trim());
    }

    [Fact]
    public void A_postgres_project_without_a_start_still_gets_the_services_so_removing_one_cannot_restart()
    {
        // Removing the last @sequenceStart is a start-only change (Npgsql: RESTART WITH 1).
        var (files, warnings) = Run("postgres", Model.Replace(", \"@sequenceStart\": 100", ""));
        Assert.Contains(files, f => f.Path == ServicesFile);
        Assert.DoesNotContain("Npgsql:IdentitySequenceOptions", files.Single(f => f.Path == "AppDbContext.g.cs").Content);
        Assert.Empty(warnings);
    }

    [Fact]
    public void Without_an_assembly_name_the_reference_is_left_out_and_the_run_says_how_to_add_it()
    {
        var (files, warnings) = Run("postgres", assembly: null);
        var services = files.Single(f => f.Path == ServicesFile).Content;
        Assert.DoesNotContain("[assembly:", services);
        var warning = Assert.Single(warnings);
        Assert.Contains("[assembly: DesignTimeServicesReference(\"Acme.AppDbContextDesignTimeServices, <assembly>\")]", warning);
        Assert.Contains("GenConfig.ContextAssemblyName", warning);
    }

    [Theory]
    [InlineData("<Project Sdk=\"Microsoft.NET.Sdk\"></Project>", "Acme.Data")]
    [InlineData("<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><AssemblyName>Acme.Persistence</AssemblyName></PropertyGroup></Project>", "Acme.Persistence")]
    public void The_assembly_name_is_read_from_the_project_the_output_is_written_into(string csproj, string expected)
    {
        var project = Directory.CreateTempSubdirectory("mo-dts-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(project, "Acme.Data.csproj"), csproj);
            var outDir = Path.Combine(project, "Generated");
            var (files, warnings) = Run("postgres", assembly: null, outDir: outDir);
            Assert.Empty(warnings);
            Assert.Contains($"\"Acme.AppDbContextDesignTimeServices, {expected}\"",
                files.Single(f => f.Path == ServicesFile).Content);
        }
        finally
        {
            Directory.Delete(project, recursive: true);
        }
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

    // Ruling R56 (item 3): @sequenceName is not refused — it describes an adopted database whose
    // sequence kept its name, which EF cannot express — and it is said once, naming the objects.
    [Fact]
    public void A_sequence_name_warns_once_and_generates()
    {
        var model = Model.Replace("\"@sequenceStart\": 100", "\"@sequenceStart\": 100, \"@sequenceName\": \"tickets_seq\"");
        var (files, warnings) = Run("postgres", model);
        Assert.Contains(files, f => f.Path == "AppDbContext.g.cs");
        var warning = Assert.Single(warnings);
        Assert.Contains("@sequenceName is not in the EF model (acme::Ticket)", warning);
    }
}
