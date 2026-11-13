// The generated EF model declares the CHECKs `meta migrate` derives —
// every validator that can carry one, and every scalar field.enum — with migrate's names and
// expression text, so one model builds one database through either delivery path (an EF
// migration or `meta migrate`). The names and text are pinned by the shared corpus
// fixtures/check-constraint-conformance/, which the TypeScript migrate suite passes too.

using System.Text.Json;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CheckConstraintConformanceTests
{
    private static string Corpus()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "check-constraint-conformance");
    }

    private static MetaRoot Load()
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(Corpus(), "input"));
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Ctx(MetaRoot root, string? dialect, bool skipRedundant = false) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Checks", Dialect = dialect, SkipRedundantChecks = skipRedundant },
    };

    public static TheoryData<string, string, bool> Cases => new()
    {
        { "expected.postgres.json", "postgres", false },
        { "expected.postgres.skip-redundant.json", "postgres", true },
        { "expected.sqlite.json", "sqlite", false },
        { "expected.d1.json", "d1", false },
        { "expected.sqlite.skip-redundant.json", "sqlite", true },
    };

    private static Dictionary<string, List<(string Name, string Expression)>> Expected(string file)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Corpus(), file)));
        return doc.RootElement.EnumerateObject().ToDictionary(
            t => t.Name,
            t => t.Value.EnumerateArray().Select(c => (c.GetProperty("name").GetString()!, c.GetProperty("expression").GetString()!)).ToList());
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void The_checks_are_meta_migrates_names_and_text(string file, string dialect, bool skipRedundant)
    {
        var ctx = Ctx(Load(), dialect, skipRedundant);
        var actual = ctx.Root.Objects()
            .Where(o => o.IsEntity() && o.DbTable is not null)
            .Select(o => (Table: CSharpNaming.Table(o), Checks: CheckConstraints.For(o, ctx.Config)))
            .Where(t => t.Checks.Count > 0)
            .ToDictionary(t => t.Table, t => t.Checks.Select(c => (c.Name, c.Expression)).ToList());
        var expected = Expected(file);
        Assert.Equal(expected.Keys.OrderBy(k => k), actual.Keys.OrderBy(k => k));
        foreach (var (table, checks) in expected)
            Assert.Equal(checks, actual[table]);
    }

    [Fact]
    public void The_context_declares_each_check_on_its_table()
    {
        var ctx = Ctx(Load(), "postgres");
        var context = new DbContextGenerator().Generate(ctx).Single(f => f.Path.EndsWith("AppDbContext.g.cs", StringComparison.Ordinal)).Content;
        Assert.Contains("modelBuilder.Entity<Gadget>().ToTable(t => t.HasCheckConstraint(\"gadgets_status_chk\", \"\\\"status\\\" IN ('DRAFT', 'LIVE')\"));", context);
        Assert.Contains("t.HasCheckConstraint(\"gadgets_sku_shape\", ", context);
        Assert.Contains("t.HasCheckConstraint(\"gadgets_email_exactlyone_chk\", \"num_nonnulls(\\\"email\\\", \\\"phone\\\") = 1\")", context);
        // A derived field is no column of the table: no CHECK names it, nor a cross-field CHECK over it.
        Assert.DoesNotContain("band", context);
        Assert.DoesNotContain("owner_name", context);
    }

    [Fact]
    public void A_project_naming_no_dialect_declares_no_check()
    {
        var context = new DbContextGenerator().Generate(Ctx(Load(), dialect: null)).Single(f => f.Path.EndsWith("AppDbContext.g.cs", StringComparison.Ordinal)).Content;
        Assert.DoesNotContain("HasCheckConstraint", context);
    }

    [Fact]
    public void The_context_with_its_checks_compiles_against_EF_Core_8()
    {
        var ctx = Ctx(Load(), "postgres");
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .Where(f => f.Path.EndsWith(".cs", StringComparison.Ordinal))
            .Select(f => Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(f.Content,
                new Microsoft.CodeAnalysis.CSharp.CSharpParseOptions(Microsoft.CodeAnalysis.CSharp.LanguageVersion.CSharp12)))
            .ToList();
        var comp = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create("checks_" + Guid.NewGuid().ToString("N"), sources,
            DbContextCompileTests.BuildReferences(),
            new Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }
}
