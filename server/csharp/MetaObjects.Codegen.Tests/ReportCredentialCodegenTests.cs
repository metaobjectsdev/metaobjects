// ReportCredentialCodegenTests — #484 follow-up: a served report hides a credential.
//
// A report column is DERIVED from its `@of` field and a derived field keeps only type-shaping
// attrs, so a dimension (or a min/max measure) over a field that declares a view.password used to
// serve the credential. The row model now marks such a derived field as a credential, and the
// routes and the export treat it exactly as they treat an entity's.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ReportCredentialCodegenTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme::secrets", "children": [
          { "object.entity": { "name": "Account", "children": [
            { "source.rdb": { "@table": "accounts" } },
            { "field.long": { "name": "id", "@required": true } },
            { "field.string": { "name": "name", "@maxLength": 100 } },
            { "field.string": { "name": "pinHash", "@maxLength": 100, "children": [ { "view.password": {} } ] } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "dimension.attribute": { "name": "name", "@of": "Account.name" } },
            { "dimension.attribute": { "name": "pinHash", "@of": "Account.pinHash" } },
            { "measure.aggregate": { "name": "accounts", "@agg": "count", "@of": "Account.id" } },
            { "measure.aggregate": { "name": "firstPin", "@agg": "min", "@of": "Account.pinHash" } }
          ] } },
          { "object.report": { "name": "AccountsByPin", "@from": "Account", "@dimensions": ["pinHash"], "@measures": ["accounts"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_pin" } } ] } },
          { "object.report": { "name": "AccountPinRange", "@from": "Account", "@dimensions": ["name"], "@measures": ["firstPin"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_account_pin_range" } } ] } },
          { "object.report": { "name": "AccountsByName", "@from": "Account", "@dimensions": ["name"], "@measures": ["accounts"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_name" } } ] } }
        ] } }
        """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "meta.secrets.json")]);
        Assert.True(r.Errors.Count == 0, string.Join("\n", r.Errors.Select(e => e.Message)));
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Gen", ColumnNamingStrategy = ColumnNamingStrategy.Literal, IncludeNames = true },
        Generators = [new RoutesGenerator(), new ReportExportGenerator { MaxRows = 60 }],
    };

    private static string Routes(GenContext ctx, string report) =>
        new RoutesGenerator().Generate(ctx).Single(f => f.Path == report + "Routes.g.cs").Content;

    private static string Export(GenContext ctx, string report) =>
        new ReportExportGenerator { MaxRows = 60 }.Generate(ctx).Single(f => f.Path == report + "Export.g.cs").Content;

    [Fact]
    public void The_row_model_marks_a_derived_credential()
    {
        var root = Load();
        var pin = ReportRows.RowModel(root.FindObject("AccountsByPin")!, root).FindField("pinHash")!;
        Assert.True(RoutesGenerator.IsCredentialField(pin));
        var range = ReportRows.RowModel(root.FindObject("AccountPinRange")!, root).FindField("firstPin")!;
        Assert.True(RoutesGenerator.IsCredentialField(range));
        var plain = ReportRows.RowModel(root.FindObject("AccountsByName")!, root);
        Assert.All(plain.Fields(), f => Assert.False(RoutesGenerator.IsCredentialField(f)));
    }

    [Theory]
    [InlineData("AccountsByPin", "pinHash")]
    [InlineData("AccountPinRange", "firstPin")]
    public void A_report_over_a_credential_omits_it_from_rows_and_export(string report, string column)
    {
        var ctx = Ctx(Load());
        var routes = Routes(ctx, report);
        Assert.Contains($"new string[] {{ \"{column}\" }}", routes);
        Assert.DoesNotContain("Results.Ok(rows)", routes);
        // The JSON export strips it too; the CSV / XML column list names no credential.
        Assert.Contains($"rows, new string[] {{ \"{column}\" }}", routes);
        var export = Export(ctx, report);
        Assert.DoesNotContain($"\"{column}\"", export);
        Assert.DoesNotContain($"row.{char.ToUpperInvariant(column[0])}{column[1..]}", export);
    }

    [Fact]
    public void A_plain_report_is_unchanged()
    {
        var ctx = Ctx(Load());
        var routes = Routes(ctx, "AccountsByName");
        Assert.DoesNotContain("CredentialOmittingResult", routes);
        Assert.Contains("Results.Ok(rows)", routes);
        Assert.Contains("ReportExportHttp.Json(http, ", routes);
        Assert.Contains("\", rows);", routes);
        Assert.Contains("\"name\"", Export(ctx, "AccountsByName"));
    }

    // A hidden column that can still narrow or order the rows is an oracle: `?filter[pinHash][like]=ab%`
    // or `?sort=pinHash` would recover the secret a prefix at a time.
    [Theory]
    [InlineData("AccountsByPin", "pinHash", "accounts")]
    [InlineData("AccountPinRange", "firstPin", "name")]
    public void A_credential_column_is_neither_filterable_nor_sortable(string report, string column, string kept)
    {
        var ctx = Ctx(Load());
        var allowlist = new FilterAllowlistGenerator().Generate(ctx).Single(f => f.Path == report + "FilterAllowlist.g.cs").Content;
        Assert.DoesNotContain($"\"{column}\"", allowlist);
        Assert.Contains($"\"{kept}\"", allowlist);

        var routes = Routes(ctx, report);
        var pascal = char.ToUpperInvariant(column[0]) + column[1..];
        Assert.DoesNotContain($"\"{pascal}\"", routes);
        Assert.Contains($"\"{char.ToUpperInvariant(kept[0])}{kept[1..]}\"", routes);
    }

    [Fact]
    public void A_plain_reports_allowlists_keep_every_column()
    {
        var ctx = Ctx(Load());
        var allowlist = new FilterAllowlistGenerator().Generate(ctx).Single(f => f.Path == "AccountsByNameFilterAllowlist.g.cs").Content;
        Assert.Contains("\"name\"", allowlist);
        Assert.Contains("\"accounts\"", allowlist);
        var routes = Routes(ctx, "AccountsByName");
        Assert.Contains("\"Name\"", routes);
        Assert.Contains("\"Accounts\"", routes);
    }

    [Fact]
    public void The_credential_report_routes_and_export_compile()
    {
        var ctx = Ctx(Load());
        var files = new IGenerator[]
            {
                new EntityGenerator(), new DbContextGenerator(), new NamesGenerator(),
                new FilterAllowlistGenerator(), new RoutesGenerator(), new ReportExportGenerator { MaxRows = 60 },
            }
            .SelectMany(g => g.Generate(ctx)).ToList();

        var paths = DbContextCompileTests.BuildReferences()
            .OfType<PortableExecutableReference>().Select(r => r.FilePath!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        string aspNetDir = Path.GetDirectoryName(typeof(Microsoft.AspNetCore.Http.IQueryCollection).Assembly.Location)!;
        foreach (var dll in Directory.GetFiles(aspNetDir, "*.dll")) paths.Add(dll);
        paths.Add(typeof(Microsoft.AspNetCore.Builder.WebApplication).Assembly.Location);
        paths.Add(typeof(Microsoft.AspNetCore.Http.Results).Assembly.Location);
        paths.Add(typeof(RoutesGenerator).Assembly.Location);

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path))
            .ToList();
        var comp = CSharpCompilation.Create(
            "report_credential_" + Guid.NewGuid().ToString("N"), trees,
            paths.Where(File.Exists).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Location.GetLineSpan().Path}: {d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }
}
