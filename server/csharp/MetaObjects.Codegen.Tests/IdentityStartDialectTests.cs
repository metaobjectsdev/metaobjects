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

    /// <summary>
    /// The warnings but the one a project with no migrations on disk always gets ("cannot tell whether
    /// EF reads the DesignTimeServicesReference"), which the I4 tests below pin.
    /// </summary>
    private static List<string> Others(List<string> warnings) =>
        warnings.Where(w => !w.Contains("cannot tell whether EF reads the DesignTimeServicesReference", StringComparison.Ordinal)).ToList();

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
        Assert.Empty(Others(warnings));
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
        Assert.StartsWith("if (Database.ProviderName == \"Npgsql.EntityFrameworkCore.PostgreSQL\") modelBuilder.Entity<global::Acme.Ticket>()", line.Trim());
    }

    [Fact]
    public void A_postgres_project_without_a_start_still_gets_the_services_so_removing_one_cannot_restart()
    {
        // Removing the last @sequenceStart is a start-only change (Npgsql: RESTART WITH 1).
        var (files, warnings) = Run("postgres", Model.Replace(", \"@sequenceStart\": 100", ""));
        Assert.Contains(files, f => f.Path == ServicesFile);
        Assert.DoesNotContain("Npgsql:IdentitySequenceOptions", files.Single(f => f.Path == "AppDbContext.g.cs").Content);
        Assert.Empty(Others(warnings));
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
            Assert.Empty(Others(warnings));
            Assert.Contains($"\"Acme.AppDbContextDesignTimeServices, {expected}\"",
                files.Single(f => f.Path == ServicesFile).Content);
        }
        finally
        {
            Directory.Delete(project, recursive: true);
        }
    }

    // rc.19 fix round (I4): EF reads [assembly: DesignTimeServicesReference] only from the startup and
    // migrations assemblies, so the reference generated into the context's assembly is read only when
    // that assembly holds the migrations. The run proves it from the model snapshot EF writes beside
    // the migrations (<Context>ModelSnapshot.cs), and otherwise warns with the exact line to add.

    private const string Line =
        "[assembly: global::Microsoft.EntityFrameworkCore.Design.DesignTimeServicesReference(\"Acme.AppDbContextDesignTimeServices, Acme.Data\", \"Npgsql.EntityFrameworkCore.PostgreSQL\")]";

    /// <summary>A repository with the context's project (Acme.Data) and, optionally, a migrations project.</summary>
    private static string Repo(string? snapshotIn, string? migrationsSource = null)
    {
        var repo = Directory.CreateTempSubdirectory("mo-dts-repo-").FullName;
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        Directory.CreateDirectory(Path.Combine(repo, "Acme.Data"));
        File.WriteAllText(Path.Combine(repo, "Acme.Data", "Acme.Data.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");
        Directory.CreateDirectory(Path.Combine(repo, "Acme.Migrations"));
        File.WriteAllText(Path.Combine(repo, "Acme.Migrations", "Acme.Migrations.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");
        if (snapshotIn is not null)
        {
            var dir = Path.Combine(repo, snapshotIn, "Migrations");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "AppDbContextModelSnapshot.cs"), Snapshot("Acme"));
            // A migration is never read for the line, even one that quotes it.
            File.WriteAllText(Path.Combine(dir, "20260101000000_Init.cs"), "// " + Line);
        }
        if (migrationsSource is not null) File.WriteAllText(Path.Combine(repo, "Acme.Migrations", "DesignTime.cs"), migrationsSource);
        return repo;
    }

    /// <summary>The model snapshot EF scaffolds for the context <c>AppDbContext</c> in <paramref name="ns"/>.</summary>
    private static string Snapshot(string ns) =>
        $"// <auto-generated />\nusing {ns};\nusing Microsoft.EntityFrameworkCore.Infrastructure;\n\nnamespace Acme.Migrations\n{{\n" +
        "    [DbContext(typeof(AppDbContext))]\n    partial class AppDbContextModelSnapshot : ModelSnapshot { }\n}\n";

    private static List<string> DesignTimeWarnings(string repo, string? assembly = null) =>
        Run("postgres", assembly: assembly, outDir: Path.Combine(repo, "Acme.Data", "Generated")).Warnings
            .Where(w => w.Contains("DesignTimeServicesReference")).ToList();

    // rc.19 fix round 2 (N1): the check errs toward warning — a false all-clear is a silent RESTART.

    [Fact]
    public void A_stale_snapshot_copy_in_the_contexts_project_does_not_hide_migrations_elsewhere()
    {
        var repo = Repo(snapshotIn: "Acme.Migrations");
        try
        {
            var stale = Path.Combine(repo, "Acme.Data", "Old");
            Directory.CreateDirectory(stale);
            File.WriteAllText(Path.Combine(stale, "AppDbContextModelSnapshot.cs"), Snapshot("Acme"));
            var warning = Assert.Single(DesignTimeWarnings(repo));
            Assert.Contains("Acme.Migrations.csproj", warning);
        }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void A_same_named_context_of_another_namespace_does_not_clear_this_one()
    {
        // Another module's AppDbContext (Billing.AppDbContext) keeps its migrations in the context's
        // project; this context (Acme.AppDbContext) has none found, so nothing proves the line is read.
        var repo = Repo(snapshotIn: null);
        try
        {
            var other = Path.Combine(repo, "Acme.Data", "Billing", "Migrations");
            Directory.CreateDirectory(other);
            File.WriteAllText(Path.Combine(other, "AppDbContextModelSnapshot.cs"), Snapshot("Billing"));
            var warning = Assert.Single(DesignTimeWarnings(repo));
            Assert.Contains("cannot tell", warning);
        }
        finally { Directory.Delete(repo, recursive: true); }
    }

    public static TheoryData<string> LinesThatDoNotCompile => new()
    {
        "// " + Line + "\n",
        "/* " + Line + " */\n",
        "#if NEVER\n" + Line + "\n#endif\n",
    };

    [Theory]
    [MemberData(nameof(LinesThatDoNotCompile))]
    public void A_line_in_a_comment_or_an_if_block_is_not_carried(string source)
    {
        var repo = Repo(snapshotIn: "Acme.Migrations", migrationsSource: source);
        try { Assert.Contains("Acme.Migrations.csproj", Assert.Single(DesignTimeWarnings(repo))); }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void A_line_naming_another_assembly_is_not_carried()
    {
        var repo = Repo(snapshotIn: "Acme.Migrations", migrationsSource: Line.Replace(", Acme.Data\"", ", Acme.OldData\"") + "\n");
        try { Assert.Contains("Acme.Migrations.csproj", Assert.Single(DesignTimeWarnings(repo, assembly: "Acme.Data"))); }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void The_carried_line_with_the_contexts_assembly_is_quiet()
    {
        var repo = Repo(snapshotIn: "Acme.Migrations", migrationsSource: Line + "\n");
        try { Assert.Empty(DesignTimeWarnings(repo, assembly: "Acme.Data")); }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void Migrations_in_the_contexts_project_need_no_line()
    {
        var repo = Repo(snapshotIn: "Acme.Data");
        try { Assert.Empty(DesignTimeWarnings(repo)); }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void Migrations_in_another_project_without_the_line_warn_with_the_line_and_the_project()
    {
        var repo = Repo(snapshotIn: "Acme.Migrations");
        try
        {
            var warning = Assert.Single(DesignTimeWarnings(repo));
            Assert.Contains(Line, warning);
            Assert.Contains("Acme.Migrations.csproj", warning);
            Assert.Contains("RESTART", warning);
        }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void Migrations_in_another_project_that_carries_the_line_are_quiet()
    {
        var repo = Repo(snapshotIn: "Acme.Migrations", migrationsSource: Line + "\n");
        try { Assert.Empty(DesignTimeWarnings(repo)); }
        finally { Directory.Delete(repo, recursive: true); }
    }

    [Fact]
    public void With_no_migrations_found_the_run_cannot_prove_it_and_warns_with_the_line()
    {
        var repo = Repo(snapshotIn: null);
        try
        {
            var warning = Assert.Single(DesignTimeWarnings(repo));
            Assert.Contains(Line, warning);
            Assert.Contains("AppDbContextModelSnapshot.cs", warning);
        }
        finally { Directory.Delete(repo, recursive: true); }
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
        var warning = Assert.Single(Others(warnings));
        Assert.Contains("@sequenceName is not in the EF model (acme::Ticket)", warning);
    }
}
