// Every emit site that spells a field's C# property goes through the one resolver
// (GenConfig.PropertyNaming / CSharpNaming.PropertyName), not CSharpNaming.Pascal on the field name.
// A key named `widgetId` that the resolver spells `WidgetID` is declared as `WidgetID` by the entity,
// so the identity-start line, a callable's argument, an extractor's mapper target, a report export
// cell and the routes must all say `WidgetID`; `WidgetId` would not compile.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PropertyNamingEmitSitesTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long": { "name": "widgetId" } },
        { "field.string": { "name": "label", "@maxLength": 40, "@sortableDefaultOrder": "desc" } },
        { "field.string": { "name": "stamp", "@mutability": "readOnly" } },
        { "identity.primary": { "@fields": "widgetId", "@generation": "increment", "@sequenceStart": 1000 } }
      ]}},
      { "object.value": { "name": "WidgetArgs", "children": [
        { "field.long": { "name": "widgetId", "@required": true } },
        { "field.int":  { "name": "maxRows" } }
      ]}},
      { "object.projection": { "name": "WidgetSummary", "children": [
        { "source.rdb": { "@kind": "storedProc", "@proc": "fn_widget_summary", "@parameterRef": "WidgetArgs" } },
        { "field.long": { "name": "widgetId" } }
      ]}},
      { "object.value": { "name": "Part", "children": [
        { "field.string": { "name": "partName", "@required": true } }
      ]}},
      { "object.value": { "name": "Gadget", "children": [
        { "field.string": { "name": "gadgetId", "@required": true } },
        { "field.object": { "name": "part", "@objectRef": "Part" } }
      ]}},
      { "template.prompt": { "name": "GadgetOut", "@payloadRef": "Gadget", "@responseRef": "Gadget",
          "@textRef": "ai/gadget", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } }
    ]}}
    """;

    private static string Spelling(MetaField f) => f.Name switch
    {
        "widgetId" => "WidgetID",
        "gadgetId" => "GadgetID",
        "maxRows" => "MaxROWS",
        "label" => "LABEL",
        _ => CSharpNaming.Pascal(f.Name),
    };

    private static GenContext Ctx(string model = Model, string? dialect = null)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "sites.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", PropertyNaming = Spelling, Dialect = dialect },
        };
    }

    private static string One(IEnumerable<EmittedFile> files, string fileName) =>
        files.Single(f => System.IO.Path.GetFileName(f.Path) == fileName).Content;

    [Fact]
    public void The_identity_start_line_names_the_resolved_property()
    {
        var files = new DbContextGenerator().Generate(Ctx(dialect: "postgres")).ToList();
        var context = One(files, "AppDbContext.g.cs");
        Assert.Contains("Property(x => x.WidgetID).HasAnnotation(", context);
        Assert.DoesNotContain("x.WidgetId", context);

        // The entity and the context agree: the pair compiles (the context's CS1061 was the symptom).
        var all = new EntityGenerator().Generate(Ctx(dialect: "postgres")).Concat(files);
        var trees = all.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create("sites_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Empty(comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}"));
    }

    [Fact]
    public void A_callable_binds_its_arguments_by_the_resolved_property_names()
    {
        var src = One(new CallableGenerator().Generate(Ctx()), "WidgetSummary.callable.g.cs");
        Assert.Contains("args.WidgetID", src);
        Assert.Contains("args.MaxROWS", src);
        Assert.DoesNotContain("args.WidgetId", src);
        Assert.DoesNotContain("args.MaxRows", src);
    }

    [Fact]
    public void An_extractor_maps_onto_the_resolved_property_names()
    {
        var src = Assert.Single(new ExtractorGenerator().Generate(Ctx())).Content;
        Assert.Contains("GadgetID = ", src);
        Assert.Contains("Part = ", src);
        Assert.DoesNotContain("GadgetId = ", src);
    }

    [Fact]
    public void The_routes_name_the_resolved_property_for_the_key_sort_and_frozen_members()
    {
        var src = One(new RoutesGenerator().Generate(Ctx()), "WidgetRoutes.g.cs");
        Assert.Contains("\"WidgetID\"", src);
        Assert.Contains("\"LABEL\"", src);
        Assert.DoesNotContain("\"WidgetId\"", src);
        Assert.DoesNotContain("\"Label\"", src);
        Assert.DoesNotContain(".WidgetId", src);
    }

    private const string ReportModel = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.entity": { "name": "Line", "children": [
        { "source.rdb": { "@table": "lines" } },
        { "field.long": { "name": "id", "@required": true } },
        { "field.string": { "name": "label", "@maxLength": 40 } },
        { "identity.primary": { "name": "id", "@fields": ["id"] } },
        { "dimension.attribute": { "name": "label", "@of": "Line.label" } },
        { "measure.aggregate": { "name": "lines", "@agg": "count", "@of": "Line.id" } }
      ] } },
      { "object.report": { "name": "LineTotals", "@from": "Line", "@dimensions": ["label"], "@measures": ["lines"],
        "children": [ { "source.rdb": { "@kind": "view", "@view": "v_line_totals" } } ] } }
    ] } }
    """;

    [Fact]
    public void A_report_export_reads_the_resolved_property_names_of_the_row()
    {
        var src = One(new ReportExportGenerator().Generate(Ctx(ReportModel)), "LineTotalsExport.g.cs");
        Assert.Contains("row.LABEL", src);
        Assert.DoesNotContain("row.Label", src);
    }
}
