// The default output (no property-naming resolver) of the generators the rc.22 property-naming fix
// touched, compared byte for byte against files in Golden/pre-rc22-propname. They were captured from the
// generators BEFORE the fix (de59161f5) and then re-captured ONLY where the credential-stripping security
// fix legitimately changed the output: the four routes files (GizmoRoutes, VehicleRoutes, TagRoutes,
// LineRoutes: the credential omit list, the strip helper call, the startup contract check and the PATCH key
// lookup). Callable, Extractor, ReportExport, FilterAllowlist and DbContext are still byte-identical to
// de59161f5. So with no resolver the output is unchanged except for that security change.
//
// Capture (re-capture only for a deliberate, reviewed output change): GOLDEN_WRITE=1 dotnet test
// --filter PropertyNamingGoldenTests. Compare mode is the default.

using System.Runtime.CompilerServices;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PropertyNamingGoldenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.value": { "name": "Dims", "children": [
        { "field.string": { "name": "unit", "@maxLength": 10 } },
        { "field.int":    { "name": "size" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name", "@maxLength": 40 } },
        { "identity.primary": { "@fields": "id", "@generation": "increment", "@sequenceStart": 500 } }
      ]}},
      { "object.entity": { "name": "Gizmo", "children": [
        { "source.rdb": { "@table": "gizmos" } },
        { "field.long":      { "name": "id" } },
        { "field.string":    { "name": "title", "@required": true, "@maxLength": 60, "@filterable": true, "@sortableDefaultOrder": "desc" } },
        { "field.string":    { "name": "stamp", "@maxLength": 20, "@mutability": "readOnly" } },
        { "field.string":    { "name": "serial", "@required": true, "@maxLength": 20, "@mutability": "readOnly" } },
        { "field.string":    { "name": "pinHash", "@maxLength": 100, "children": [ { "view.password": {} } ] } },
        { "field.string":    { "name": "tokenHash", "@maxLength": 100, "@formExclude": true } },
        { "field.timestamp": { "name": "createdAt", "@required": true, "@autoSet": "onCreate" } },
        { "field.timestamp": { "name": "updatedAt", "@required": true, "@autoSet": "onUpdate" } },
        { "field.object":    { "name": "dims", "@objectRef": "Dims" } },
        { "field.map":       { "name": "extras", "@objectRef": "Dims" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "vehicles" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "kind", "@values": ["Car", "Van"] } },
        { "field.string": { "name": "plate", "@maxLength": 20, "@filterable": true } },
        { "field.string": { "name": "vinHash", "@maxLength": 100, "children": [ { "view.password": {} } ] } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "VehicleTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
        { "field.int": { "name": "seatCount" } },
        { "field.string": { "name": "regNo", "@maxLength": 20, "@mutability": "readOnly" } }
      ]}},
      { "object.entity": { "name": "Van", "extends": "Vehicle", "@discriminatorValue": "Van", "children": [
        { "field.int": { "name": "payloadKg" } }
      ]}},
      { "object.entity": { "name": "VehicleTag", "children": [
        { "source.rdb": { "@table": "vehicle_tags" } },
        { "field.long": { "name": "vehicleId", "@required": true } },
        { "field.long": { "name": "tagId", "@required": true } },
        { "identity.primary": { "@fields": ["vehicleId", "tagId"] } },
        { "identity.reference": { "name": "fkVehicle", "@fields": "vehicleId", "@references": "Vehicle" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}}
      ,{ "object.value": { "name": "WidgetArgs", "children": [
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
          "@textRef": "ai/gadget", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } },
      { "object.entity": { "name": "Line", "children": [
        { "source.rdb": { "@table": "lines" } },
        { "field.long": { "name": "id", "@required": true } },
        { "field.string": { "name": "label", "@maxLength": 40 } },
        { "identity.primary": { "name": "id", "@fields": ["id"] } },
        { "dimension.attribute": { "name": "label", "@of": "Line.label" } },
        { "measure.aggregate": { "name": "lines", "@agg": "count", "@of": "Line.id" } }
      ]}},
      { "object.report": { "name": "LineTotals", "@from": "Line", "@dimensions": ["label"], "@measures": ["lines"],
        "children": [ { "source.rdb": { "@kind": "view", "@view": "v_line_totals" } } ] } }
    ]}}
    """;

    private static string GoldenDir([CallerFilePath] string here = "") =>
        Path.Combine(Path.GetDirectoryName(here)!, "Golden", "pre-rc22-propname");

    [Fact]
    public void Default_output_matches_the_output_captured_before_the_property_naming_fix()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "golden-rc22.json")]);
        Assert.Empty(r.Errors);
        GenContext Ctx(string? dialect = null) => new()
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutputLayout = OutputLayout.Package, PackageNamespacesFromMetadata = true, OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal, Dialect = dialect },
        };
        var files = new RoutesGenerator().Generate(Ctx())
            .Concat(new CallableGenerator().Generate(Ctx()))
            .Concat(new ExtractorGenerator().Generate(Ctx()))
            .Concat(new ReportExportGenerator().Generate(Ctx()))
            .Concat(new FilterAllowlistGenerator().Generate(Ctx()))
            .Concat(new DbContextGenerator().Generate(Ctx("postgres")))
            .ToList();
        var names = files.Select(f => System.IO.Path.GetFileName(f.Path)).ToList();
        foreach (var name in new[] { "VehicleRoutes.g.cs", "GizmoRoutes.g.cs", "WidgetSummary.callable.g.cs", "LineTotalsExport.g.cs", "AppDbContext.g.cs", "GizmoFilterAllowlist.g.cs" })
            Assert.Contains(name, names);
        Assert.True(names.Any(n => n.Contains("Extractor")), string.Join(",", names));

        var dir = GoldenDir();
        if (Environment.GetEnvironmentVariable("GOLDEN_WRITE") == "1")
        {
            Directory.CreateDirectory(dir);
            foreach (var f in files) File.WriteAllText(Path.Combine(dir, System.IO.Path.GetFileName(f.Path)), f.Content);
            return;
        }
        var expected = Directory.GetFiles(dir).Select(p => Path.GetFileName(p)).Order(StringComparer.Ordinal).ToList();
        var actualNames = files.Select(f => System.IO.Path.GetFileName(f.Path)).Order(StringComparer.Ordinal).ToList();
        Assert.True(expected.SequenceEqual(actualNames),
            $"golden file set differs. missing from output: [{string.Join(", ", expected.Except(actualNames))}]; not in golden: [{string.Join(", ", actualNames.Except(expected))}]");
        foreach (var f in files)
        {
            var name = System.IO.Path.GetFileName(f.Path);
            var golden = File.ReadAllText(Path.Combine(dir, name));
            if (golden != f.Content) Assert.Fail(FirstDifference(name, golden, f.Content));
        }
    }

    // A golden mismatch names the file, the first differing line and both spellings, so a failure that
    // shows only on another machine can be read from its log instead of reproduced.
    private static string FirstDifference(string name, string golden, string actual)
    {
        var g = golden.Split('\n');
        var a = actual.Split('\n');
        var i = 0;
        while (i < g.Length && i < a.Length && g[i] == a[i]) i++;
        string At(string[] lines, int n) => n < lines.Length ? lines[n].Replace("\r", "\\r") : "<end of file>";
        return $"{name}: output differs from its golden at line {i + 1} (golden {g.Length} lines, output {a.Length} lines)\n" +
               $"  golden: {At(g, i)}\n  output: {At(a, i)}\n  culture: {System.Globalization.CultureInfo.CurrentCulture.Name}; cwd: {Directory.GetCurrentDirectory()}";
    }
}
