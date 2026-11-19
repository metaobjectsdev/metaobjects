// rc.19 item 13 (rulings R55): the generated EF model declares the CHECKs `meta migrate` derives —
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
            // A TPH subtype has no table of its own: its CHECKs are its base's (FR-017).
            .Where(o => o.IsEntity() && o.DbTable is not null && !InstanceArtifacts.IsAbstract(o) && !TphPlanBuilder.IsTphSubtype(o, ctx.Root))
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
        // rc.20 @dbCheck: false — the opted-out validators and enum declare no CHECK; a sibling
        // validator on the same field keeps its own.
        Assert.DoesNotContain("gadgets_npi_", context);
        Assert.DoesNotContain("gadgets_legacy_state_chk", context);
        Assert.DoesNotContain("\\\"rank\\\" >= 1", context);
        Assert.Contains("t.HasCheckConstraint(\"gadgets_rank_numeric_chk\", \"\\\"rank\\\" <= 99\")", context);
        // FR-017 TPH: a subtype's columns are on its base's table, and so are their CHECKs.
        Assert.Contains("modelBuilder.Entity<Device>().ToTable(t => t.HasCheckConstraint(\"devices_mode_chk\", \"\\\"mode\\\" IN ('AUTO', 'MANUAL')\"));", context);
        Assert.Contains("t.HasCheckConstraint(\"devices_sensor_unit_reqwhen_chk\", ", context);
        // rc.21 fix round (I1): siblings that disagree on a shared column each guard their own CHECK.
        Assert.Contains("t.HasCheckConstraint(\"devices_switch_grade_chk\", \"(\\\"kind\\\" <> 'SWITCH') OR (\\\"grade\\\" IN ('X', 'Y'))\")", context);
        Assert.DoesNotContain("devices_legacy_position_chk", context);
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

    // rc.21 fix round (I2): two different CHECKs under one default name are refused, naming both.
    [Fact]
    public void Two_checks_under_one_name_are_refused()
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource("""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Window", "children": [
                { "source.rdb": { "@table": "windows" } },
                { "field.long": { "name": "id" } },
                { "field.int": { "name": "a" } }, { "field.int": { "name": "b" } }, { "field.int": { "name": "c" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
                { "validator.comparison": { "name": "ab", "@left": "a", "@op": "lt", "@right": "b" } },
                { "validator.comparison": { "name": "ac", "@left": "a", "@op": "lt", "@right": "c" } } ] } } ] } }
            """, id: "w.json")]);
        Assert.Empty(load.Errors);
        var ex = Assert.Throws<InvalidOperationException>(() => CheckConstraints.For(load.Root.Objects().Single(), Ctx(load.Root, "postgres").Config));
        Assert.Contains("both named 'windows_a_cmp_chk'", ex.Message);
        Assert.Contains("Postgres requires each constraint on a table to have its own name", ex.Message);
        // rc.21 part B (N1): SQLite and D1 accept the pair (meta migrate keeps both), but EF's model
        // keys a check constraint by name and would keep only the last, so C# still refuses it there.
        foreach (var dialect in new[] { "sqlite", "d1" })
        {
            var lite = Assert.Throws<InvalidOperationException>(() => CheckConstraints.For(load.Root.Objects().Single(), Ctx(load.Root, dialect).Config));
            Assert.Contains("EF Core keeps one check constraint per name", lite.Message);
        }
    }

    // rc.21 part B (N2): a generated name fitted to Postgres's 63-byte limit, spelled as meta migrate spells it.
    [Fact]
    public void FitPgIdentifier_matches_the_TypeScript_spelling()
    {
        Assert.Equal("devices_meter_serial_regex_chk", CheckConstraints.FitPgIdentifier("devices_meter_serial_regex_chk"));
        Assert.Equal("measurement_devices_with_a_rather_long_table_name_mete_559a7830",
            CheckConstraints.FitPgIdentifier("measurement_devices_with_a_rather_long_table_name_meterdevicekind_serial_chk"));
        Assert.Equal(new string('é', 27) + "_84fe2e03", CheckConstraints.FitPgIdentifier(new string('é', 40)));
    }

    [Fact]
    public void A_qualified_TPH_check_name_over_63_bytes_is_fitted_on_Postgres_only()
    {
        const string table = "measurement_devices_with_a_rather_long_table_name";
        var load = new MetaDataLoader().Load([new InMemoryStringSource($$"""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Device", "@discriminator": "kind", "children": [
                { "source.rdb": { "@table": "{{table}}" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "kind", "@maxLength": 20 } },
                { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
              { "object.entity": { "name": "MeterDeviceKind", "extends": "Device", "@discriminatorValue": "METER", "children": [
                { "field.enum": { "name": "serial", "@values": ["M1", "M2"] } } ] } },
              { "object.entity": { "name": "SensorDeviceKind", "extends": "Device", "@discriminatorValue": "SENSOR", "children": [
                { "field.enum": { "name": "serial", "@values": ["S1", "S2"] } } ] } } ] } }
            """, id: "d.json")]);
        Assert.Empty(load.Errors);
        var device = load.Root.Objects().Single(o => o.Name == "Device");
        IEnumerable<string> Names(string dialect) => CheckConstraints.For(device, Ctx(load.Root, dialect).Config)
            .Where(c => c.Expression.Contains("serial")).Select(c => c.Name);
        Assert.Equal(new[] { "measurement_devices_with_a_rather_long_table_name_mete_559a7830",
            CheckConstraints.FitPgIdentifier($"{table}_sensordevicekind_serial_chk") }, Names("postgres"));
        Assert.Equal(new[] { $"{table}_meterdevicekind_serial_chk", $"{table}_sensordevicekind_serial_chk" }, Names("sqlite"));
    }
}
