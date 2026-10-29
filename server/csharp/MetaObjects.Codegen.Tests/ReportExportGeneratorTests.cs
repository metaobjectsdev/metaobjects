// report-export: the generator, the routes wiring, the shared writer and the HTTP helper
// (docs/features/api-contract.md, "Report export"). The corpus lane (ApiContractReportConformanceTest)
// proves the served behaviour; these prove the pieces without a database.

using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.Extensions.Primitives;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.Runtime;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ReportExportGeneratorTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme::shop", "children": [
          { "object.entity": { "name": "Line", "children": [
            { "source.rdb": { "@table": "lines" } },
            { "field.long": { "name": "id", "@required": true } },
            { "field.string": { "name": "label", "@maxLength": 40 } },
            { "field.long": { "name": "amountCents", "@required": true } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "dimension.attribute": { "name": "label", "@of": "Line.label" } },
            { "measure.aggregate": { "name": "lines", "@agg": "count", "@of": "Line.id" } },
            { "measure.aggregate": { "name": "total", "@agg": "sum", "@of": "Line.amountCents" } }
          ] } },
          { "object.report": { "name": "LineTotals", "@from": "Line", "@dimensions": ["label"], "@measures": ["lines", "total"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_line_totals" } } ] } },
          { "object.report": { "name": "NoView", "@from": "Line", "@dimensions": ["label"], "@measures": ["lines"] } }
        ] } }
        """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "meta.shop.json")]);
        Assert.True(r.Errors.Count == 0, string.Join("\n", r.Errors.Select(e => e.Message)));
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, params IGenerator[] run) => new()
    {
        Entities = root.Objects().Where(o => !o.IsReport()).ToList(),
        Root = root,
        Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Gen", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        Generators = run,
    };

    private static string Routes(GenContext ctx) =>
        new RoutesGenerator().Generate(ctx).Single(f => f.Path == "LineTotalsRoutes.g.cs").Content;

    [Fact]
    public void Routes_are_unchanged_when_no_export_generator_is_wired()
    {
        var root = Load();
        var plain = Routes(Ctx(root));
        var listedOthers = Routes(Ctx(root, new EntityGenerator(), new RoutesGenerator()));
        Assert.Equal(plain, listedOthers);
    }

    [Fact]
    public void Routes_change_only_when_the_export_generator_is_listed()
    {
        var root = Load();
        var plain = Routes(Ctx(root, new RoutesGenerator()));
        var wired = Routes(Ctx(root, new RoutesGenerator(), new ReportExportGenerator { MaxRows = 60 }));
        Assert.NotEqual(plain, wired);
    }

    [Fact]
    public void A_hand_edits_wrapper_does_not_hide_the_wiring()
    {
        var root = Load();
        var ctx = Ctx(root, new ReportExportGenerator { MaxRows = 7 }.WithHandEdits(HandEdits.Overwrite));
        Assert.Equal(7, ctx.ReportExportMaxRows);
        Assert.Null(Ctx(root, new RoutesGenerator()).ReportExportMaxRows);
    }

    [Fact]
    public void It_writes_one_shared_writer_and_one_module_per_served_report_only()
    {
        var files = new ReportExportGenerator().Generate(Ctx(Load())).ToDictionary(f => f.Path, f => f.Content);
        Assert.Equal(["LineTotalsExport.g.cs", "ReportExportWriter.g.cs"], files.Keys.OrderBy(k => k, StringComparer.Ordinal));
        var module = files["LineTotalsExport.g.cs"];
        Assert.Contains("Root = \"LineTotals\"", module);
        Assert.Matches(@"""label"",\s+""lines"",\s+""total""", module);
        Assert.Contains("ExportCsvBom = false;", files["ReportExportWriter.g.cs"]);
        Assert.Contains("XmlNil = true;", files["ReportExportWriter.g.cs"]);
    }

    [Fact]
    public void Options_reach_the_shared_writer()
    {
        var writer = new ReportExportGenerator { CsvBom = true, XmlNulls = ReportExportXmlNulls.Empty }
            .Generate(Ctx(Load())).Single(f => f.Path == "ReportExportWriter.g.cs").Content;
        Assert.Contains("ExportCsvBom = true;", writer);
        Assert.Contains("XmlNil = false;", writer);
    }

    [Fact]
    public void Nothing_is_written_for_a_model_with_no_served_report()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(
            """{ "metadata.root": { "package": "a::b", "children": [ { "object.entity": { "name": "X", "children": [ { "field.long": { "name": "id" } } ] } } ] } }""", id: "m.json")]);
        Assert.Empty(new ReportExportGenerator().Generate(Ctx(r.Root)));
    }

    // ---- the shared writer, compiled and run -------------------------------------------------

    private const string Harness = """
        namespace Acme.Gen;
        public static class Harness
        {
            public static string Csv(object?[][] rows, string[] cols, bool[]? asText = null)
            {
                var w = new System.IO.StringWriter();
                ReportExportWriter.WriteCsv(w, cols, rows.Select(r => r.Select(ReportExportWriter.Cell).ToArray()));
                return w.ToString();
            }
            public static string Xml(object?[][] rows, string[] cols)
            {
                var w = new System.IO.StringWriter();
                ReportExportWriter.WriteXml(w, "Root", cols, rows.Select(r => r.Select(ReportExportWriter.Cell).ToArray()));
                return w.ToString();
            }
        }
        """;

    private static MethodInfo[] Compile(ReportExportGenerator gen, string? decimals = null)
    {
        var root = Load();
        if (decimals == "string") root.WireFormat = new WireFormat(DecimalWireForm.String, NullMemberForm.Native);
        var writer = gen.Generate(Ctx(root)).Single(f => f.Path == "ReportExportWriter.g.cs").Content;
        var tpa = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p));
        var comp = CSharpCompilation.Create("export_writer_" + Guid.NewGuid().ToString("N"),
            [CSharpSyntaxTree.ParseText(writer), CSharpSyntaxTree.ParseText("using System.Linq;\n" + Harness)], tpa,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var t = Assembly.Load(ms.ToArray()).GetType("Acme.Gen.Harness")!;
        return [t.GetMethod("Csv")!, t.GetMethod("Xml")!];
    }

    private static string Csv(MethodInfo[] h, object?[][] rows, params string[] cols) => (string)h[0].Invoke(null, [rows, cols, null])!;
    private static string Xml(MethodInfo[] h, object?[][] rows, params string[] cols) => (string)h[1].Invoke(null, [rows, cols])!;

    [Fact]
    public void Csv_quotes_ends_every_record_with_crlf_and_guards_text_cells_only()
    {
        var h = Compile(new ReportExportGenerator());
        var csv = Csv(h, [
            ["=SUM(1)", 1L], ["+1", 2L], ["-2", 3L], ["@cmd", 4L], ["\tx", 5L], ["\rx", 6L],
            ["a,b", -7L], ["say \"hi\"", 8L], ["l1\nl2", 9L], [null, null], ["", 0L],
        ], "label", "n");
        Assert.Equal(
            "label,n\r\n'=SUM(1),1\r\n'+1,2\r\n'-2,3\r\n'@cmd,4\r\n'\tx,5\r\n\"'\rx\",6\r\n\"a,b\",-7\r\n\"say \"\"hi\"\"\",8\r\n\"l1\nl2\",9\r\n,\r\n,0\r\n",
            csv);
    }

    [Fact]
    public void Csv_never_guards_numbers_dates_decimals_or_booleans_and_writes_wire_forms()
    {
        var h = Compile(new ReportExportGenerator());
        var csv = Csv(h, [[-5L, -1.5m, new DateOnly(2026, 6, 1), true, new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.FromHours(2))]],
            "a", "b", "c", "d", "e");
        Assert.Equal("a,b,c,d,e\r\n-5,-1.5,2026-06-01,true,2026-01-02T01:04:05Z\r\n", csv);
    }

    [Fact]
    public void Timestamps_are_written_as_the_list_route_writes_them()
    {
        var options = new System.Text.Json.JsonSerializerOptions();
        options.Converters.Add(new Iso8601TimestampConverter());
        var h = Compile(new ReportExportGenerator());
        var instants = new[]
        {
            new DateTimeOffset(2026, 1, 2, 10, 0, 0, TimeSpan.Zero),
            new DateTimeOffset(2026, 1, 2, 10, 0, 0, 120, TimeSpan.Zero),
            new DateTimeOffset(2026, 1, 2, 10, 0, 0, TimeSpan.Zero).AddTicks(1_234_560),
        };
        foreach (var instant in instants)
        {
            var wire = System.Text.Json.JsonSerializer.Serialize(instant, options).Trim('"');
            Assert.Equal($"t\r\n{wire}\r\n", Csv(h, [[instant]], "t"));
        }
        Assert.Equal("t\r\n2026-01-02T10:00:00.120Z\r\n", Csv(h, [[instants[1]]], "t"));
    }

    [Fact]
    public void Decimals_follow_the_wire_setting()
    {
        Assert.Equal("d\r\n12.50\r\n", Csv(Compile(new ReportExportGenerator()), [[12.50m]], "d"));
        Assert.Equal("d\r\n12.5\r\n", Csv(Compile(new ReportExportGenerator(), "string"), [[12.50m]], "d"));
    }

    [Fact]
    public void The_bom_is_a_generated_constant()
    {
        Assert.StartsWith("﻿a", Csv(Compile(new ReportExportGenerator { CsvBom = true }), [["x"]], "a"));
        Assert.StartsWith("a", Csv(Compile(new ReportExportGenerator()), [["x"]], "a"));
    }

    [Fact]
    public void Xml_escapes_entitizes_newlines_has_no_guard_and_writes_nil()
    {
        var h = Compile(new ReportExportGenerator());
        var xml = Xml(h, [["=<&>\n\r", null]], "a", "b");
        Assert.Equal(
            "<Root xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><row><a>=&lt;&amp;&gt;\n&#xD;</a><b xsi:nil=\"true\" /></row></Root>", xml);
        Assert.Contains("xmlns:xsi=", Xml(h, [], "a"));
    }

    [Fact]
    public void Xml_empty_mode_declares_nothing_and_writes_an_empty_element()
    {
        var h = Compile(new ReportExportGenerator { XmlNulls = ReportExportXmlNulls.Empty });
        Assert.Equal("<Root><row><a /></row></Root>", Xml(h, [[null]], "a"));
    }

    [Fact]
    public void Xml_replaces_characters_xml_cannot_carry_instead_of_failing()
    {
        Assert.Contains("a�b", Xml(Compile(new ReportExportGenerator()), [["a\u0001b"]], "c"));
    }

    // ---- the HTTP helper -----------------------------------------------------------------------

    private static IQueryCollection Q(params (string k, string v)[] kv) =>
        new QueryCollection(kv.ToDictionary(p => p.k, p => new StringValues(p.v)));

    [Theory]
    [InlineData("csv"), InlineData("json"), InlineData("xml")]
    public void Wired_formats_proceed(string format) => Assert.Null(ReportExportHttp.Refuse(format, Q(("format", format))));

    [Theory]
    [InlineData("xlsx"), InlineData("CSV"), InlineData("")]
    public void Anything_else_is_invalid_format(string format) =>
        Assert.NotNull(ReportExportHttp.Refuse(format, Q(("format", format))));

    [Fact]
    public void No_format_is_never_refused_and_withCount_is_refused_for_csv_and_xml_only()
    {
        Assert.Null(ReportExportHttp.Requested(Q()));
        Assert.Null(ReportExportHttp.Refuse(null, Q(("withCount", "1"))));
        Assert.Null(ReportExportHttp.Refuse("json", Q(("format", "json"), ("withCount", "1"))));
        Assert.NotNull(ReportExportHttp.Refuse("csv", Q(("format", "csv"), ("withCount", "TRUE"))));
        Assert.NotNull(ReportExportHttp.Refuse("xml", Q(("format", "xml"), ("withCount", "1"))));
        Assert.Null(ReportExportHttp.Refuse("csv", Q(("format", "csv"), ("withCount", "0"))));
        Assert.Equal(["csv", "json", "xml"], ReportExportHttp.Formats);
    }

    // docs/features/api-contract.md, "Report export": a credential column (a grouped or min/max
    // view.password field) is never returned, so its key is absent from a JSON export's rows,
    // with or without the { rows, total } envelope, and the report's other columns stay.
    public sealed record PinRow(string Name, string PinHash, long Accounts);

    private static async Task<System.Text.Json.Nodes.JsonNode> ExportJson(object body, bool envelope, bool camelCase)
    {
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        Microsoft.Extensions.DependencyInjection.LoggingServiceCollectionExtensions.AddLogging(services);
        Microsoft.Extensions.DependencyInjection.OptionsServiceCollectionExtensions.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(
            services, o =>
            {
                o.SerializerOptions.PropertyNamingPolicy = camelCase ? System.Text.Json.JsonNamingPolicy.CamelCase : null;
                o.SerializerOptions.PropertyNameCaseInsensitive = false;
            });
        var http = new DefaultHttpContext
        {
            RequestServices = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services),
        };
        http.Response.Body = new MemoryStream();
        await ReportExportHttp.Json(http, "accounts-by-pin", body, ["pinHash"], envelope).ExecuteAsync(http);
        Assert.Equal("attachment; filename=\"accounts-by-pin.json\"", http.Response.Headers.ContentDisposition.ToString());
        http.Response.Body.Position = 0;
        return System.Text.Json.Nodes.JsonNode.Parse(http.Response.Body)!;
    }

    [Theory]
    [InlineData(false, true), InlineData(true, true), InlineData(false, false), InlineData(true, false)]
    public async Task Json_export_omits_the_credential_key_from_every_row(bool envelope, bool camelCase)
    {
        PinRow[] rows = [new("Ann", "hash-a", 2), new("Bob", "hash-b", 3)];
        var json = await ExportJson(envelope ? new { rows, total = 2 } : rows, envelope, camelCase);
        var served = (envelope ? json["rows"] : json)!.AsArray();
        Assert.Equal(2, served.Count);
        foreach (var row in served.Select(r => r!.AsObject()))
        {
            Assert.DoesNotContain(row, p => string.Equals(p.Key, "pinHash", StringComparison.OrdinalIgnoreCase));
            Assert.Contains(row, p => string.Equals(p.Key, "accounts", StringComparison.OrdinalIgnoreCase));
            Assert.Contains(row, p => string.Equals(p.Key, "name", StringComparison.OrdinalIgnoreCase));
        }
        Assert.DoesNotContain("hash-", json.ToJsonString());
        if (envelope) Assert.Equal(2, json["total"]!.GetValue<int>());
    }
}
