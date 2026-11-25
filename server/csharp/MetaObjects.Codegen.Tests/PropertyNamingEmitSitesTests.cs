// Every emit site that spells a field's C# property goes through the one resolver
// (GenConfig.PropertyNaming / CSharpNaming.PropertyName), not CSharpNaming.Pascal on the field name.
// A key named `widgetId` that the resolver spells `WidgetID` is declared as `WidgetID` by the entity,
// so the identity-start line, a callable's argument, an extractor's mapper target, a report export
// cell and the routes must all say `WidgetID`; `WidgetId` would not compile.

using System.IO;
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
            Config = new GenConfig { OutputLayout = OutputLayout.Package, PackageNamespacesFromMetadata = true, OutDir = "/tmp", Namespace = "Acme.Generated", PropertyNaming = Spelling, Dialect = dialect },
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

    // ---- every routes site, every field renamed beyond case ----

    private const string AllSitesModel = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.value": { "name": "Dims", "children": [
        { "field.string": { "name": "unit", "@maxLength": 10 } },
        { "field.int":    { "name": "size" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name", "@maxLength": 40 } },
        { "identity.primary": { "@fields": "id" } }
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
    ]}}
    """;

    // Every field spelled beyond case: nothing here is the PascalCase of its name.
    private static string XSpelling(MetaField f) => "X" + CSharpNaming.Pascal(f.Name);

    private static GenContext AllSitesCtx() => AllSitesCtx(XSpelling);

    private static GenContext AllSitesCtx(Func<MetaField, string>? naming)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(AllSitesModel, id: "all-sites.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig
            { OutputLayout = OutputLayout.Package, PackageNamespacesFromMetadata = true,
                OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                PropertyNaming = naming,
            },
        };
    }

    private static List<EmittedFile> AllSites(GenContext ctx) =>
        new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();

    private static List<string> CompileAll(IEnumerable<EmittedFile> files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path)).ToList();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator)) if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.PrimaryKeyAttribute).Assembly.Location);
        paths.Add(typeof(MetaObjects.AspNetCore.FilterParser).Assembly.Location);
        var refs = paths.Where(File.Exists).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("all_sites_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()} @ {d.Location}").ToList();
    }

    [Fact]
    public void A_model_with_every_routes_site_compiles_with_every_field_renamed()
    {
        var errors = CompileAll(AllSites(AllSitesCtx()));
        Assert.True(errors.Count == 0, "entity + context + filter allowlist + routes should compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Without_a_resolver_the_same_model_compiles_and_names_the_pascal_properties()
    {
        var files = AllSites(AllSitesCtx(null));
        Assert.Empty(CompileAll(files));
        Assert.DoesNotContain("PropertyByField", One(files, "GizmoFilterAllowlist.g.cs"));
    }

    [Fact]
    public void A_renamed_credential_is_stripped_from_every_response_and_refused_on_every_write()
    {
        var files = AllSites(AllSitesCtx());
        var gizmo = One(files, "GizmoRoutes.g.cs");
        var vehicle = One(files, "VehicleRoutes.g.cs");

        // The credential is named by its CLR property; the JSON key is the serializer's, read at run time
        // (SerializerKeys.StripBody), never spelled here.
        Assert.Contains("new string[] { \"XPinHash\", \"pinHash\" }", gizmo);
        Assert.Contains("new string[] { \"XVinHash\", \"vinHash\" }", vehicle);
        Assert.Contains("SerializerKeys.StripBody(node, _value, _envelope, opts, _names);", gizmo);
        Assert.DoesNotContain("OrdinalIgnoreCase))\n                o.Remove", gizmo);

        // No response shape bypasses the stripping result: read, list, list-with-count, create, PATCH.
        Assert.DoesNotContain("Results.Ok(rows", gizmo);
        Assert.DoesNotContain("Results.Ok(found", gizmo);
        Assert.DoesNotContain("Results.Ok(existing", gizmo);
        Assert.DoesNotContain("Results.Ok(new { rows, total })", gizmo);
        Assert.DoesNotContain("Results.Created(", gizmo);
        Assert.Contains("new CredentialOmittingResult(", gizmo);
        // The TPH routes' only plain Results.Ok(rows) are the M:N Tag lists (no credential on a Tag).
        Assert.DoesNotContain("Results.Created(", vehicle);
        Assert.DoesNotContain("Results.Ok(existing", vehicle);
        Assert.Contains("new CredentialOmittingResult(", vehicle);

        // PATCH refuses to write it: the deny arm matches the serializer-resolved property, and both spellings.
        Assert.Contains("if (__clr is \"XPinHash\" or \"XTokenHash\") continue;", gizmo);
        Assert.Contains("SerializerKeys.PropertyByKey(existing.GetType(), jsonOpts)", gizmo);
        foreach (var k in new[] { "pinHash", "XPinHash", "tokenHash", "XTokenHash" })
            Assert.Contains($"string.Equals(prop.Name, \"{k}\", System.StringComparison.OrdinalIgnoreCase)) continue; // @formExclude / credential", gizmo);
        // Create resets the resolved property, so the two writes agree.
        Assert.Contains("input.XPinHash = default!;", gizmo);
        Assert.Contains("input.XTokenHash = default!;", gizmo);
        // The TPH subtype PATCH matches the base's credential under both spellings too.
        Assert.Contains("\"XVinHash\"", vehicle);
        Assert.Contains("input.XVinHash = default!;", vehicle);
    }

    [Fact]
    public void A_renamed_value_object_and_map_patch_arm_matches_both_spellings()
    {
        var gizmo = One(AllSites(AllSitesCtx()), "GizmoRoutes.g.cs");
        Assert.Contains("string.Equals(prop.Name, \"dims\", System.StringComparison.OrdinalIgnoreCase) || string.Equals(prop.Name, \"XDims\", System.StringComparison.OrdinalIgnoreCase)", gizmo);
        Assert.Contains("string.Equals(prop.Name, \"extras\", System.StringComparison.OrdinalIgnoreCase) || string.Equals(prop.Name, \"XExtras\", System.StringComparison.OrdinalIgnoreCase)", gizmo);
        Assert.Contains("existing.XDims =", gizmo);
        Assert.Contains("existing.XExtras =", gizmo);
    }

    [Fact]
    public void Sort_and_EF_property_names_are_the_resolved_names_at_every_site()
    {
        var files = AllSites(AllSitesCtx());
        var gizmo = One(files, "GizmoRoutes.g.cs");
        var vehicle = One(files, "VehicleRoutes.g.cs");
        Assert.Contains("\"XTitle\" =>", gizmo);
        Assert.Contains("EF.Property<object>(x!, \"XTitle\")", gizmo);
        Assert.Contains("[\"XTitle\"] = new SortFieldRule(\"desc\", \"XTitle\"),", gizmo); // @sortableDefaultOrder keys
        Assert.DoesNotContain("\"Title\"", gizmo);
        Assert.Contains("EF.Property<object>(x!, \"XPlate\")", vehicle);        // TPH base
        Assert.Contains("[\"XSeatCount\"] = new SortFieldRule(property: \"XSeatCount\"),", vehicle); // per-subtype sort rules
        // A rename beyond case: ?sort= also takes the field name (the key ?filter[...] takes), resolved to the property.
        Assert.Contains("Dictionary<string, SortFieldRule> SortRules", gizmo);
        Assert.Contains("[\"title\"] = new SortFieldRule(\"desc\", \"XTitle\"),", gizmo);
        Assert.Contains("[\"seatCount\"] = new SortFieldRule(property: \"XSeatCount\"),", vehicle);
        Assert.Contains("[\"plate\"] = new SortFieldRule(property: \"XPlate\"),", vehicle);
        Assert.DoesNotContain("\"Plate\"", vehicle);
        // M:N junction: the FK properties and the target key, by their resolved names.
        Assert.Contains("EF.Property<long>(j, \"XVehicleId\")", vehicle);
        Assert.Contains("EF.Property<long>(j, \"XTagId\")", vehicle);
        Assert.Contains("EF.Property<long>(t, \"XId\")", vehicle);
        Assert.DoesNotContain("\"VehicleId\"", vehicle);
    }

    [Fact]
    public void Frozen_autoset_readonly_and_discriminator_members_use_the_resolved_names()
    {
        var files = AllSites(AllSitesCtx());
        var gizmo = One(files, "GizmoRoutes.g.cs");
        var vehicle = One(files, "VehicleRoutes.g.cs");
        // Frozen (readOnly) members are skipped in the PATCH merge by their property name.
        Assert.Contains("\"XStamp\"", gizmo);
        Assert.Contains("\"XSerial\"", gizmo);
        Assert.DoesNotContain("\"Stamp\"", gizmo);
        // @autoSet columns are stamped through the resolved properties.
        Assert.Contains("XCreatedAt", gizmo);
        Assert.Contains("XUpdatedAt", gizmo);
        Assert.DoesNotContain(".CreatedAt", gizmo);
        // The TPH discriminator is immutable under its resolved name, and is reset on create.
        Assert.Contains("\"XKind\"", vehicle);
        Assert.Contains("input.XKind = default!;", vehicle);
        Assert.Contains("input.Tags = new", vehicle);   // the M:N navigation reset: a navigation, not a field
    }

    [Fact]
    public void The_filter_dispatch_is_given_the_property_map_when_a_rename_goes_beyond_case()
    {
        var files = AllSites(AllSitesCtx());
        var allowlist = One(files, "GizmoFilterAllowlist.g.cs");
        Assert.Contains("[\"title\"] = \"XTitle\"", allowlist);
        var gizmo = One(files, "GizmoRoutes.g.cs");
        Assert.Contains("GizmoFilterAllowlist.PropertyByField", gizmo);
        Assert.Contains("EfCoreFilterDispatch.Apply(q, listQuery, GizmoFilterAllowlist.Rules, GizmoFilterAllowlist.PropertyByField)", gizmo);
    }

    private sealed class FilterRow
    {
        public long OwnerKey { get; set; }
    }

    [Fact]
    public void The_filter_dispatch_finds_a_property_the_resolver_renamed_beyond_case()
    {
        var predicates = new[] { new MetaObjects.AspNetCore.FilterPredicate("ownerRef", "eq", "5") };
        var map = new Dictionary<string, string> { ["ownerRef"] = "OwnerKey" };
        var rows = new[] { new FilterRow { OwnerKey = 5 }, new FilterRow { OwnerKey = 6 } }.AsQueryable();

        // With the map the field resolves to its property; without it the lookup misses (the 500 this guards).
        var filtered = MetaObjects.AspNetCore.EfCoreFilterDispatch.ApplyFilter(rows, predicates, map).ToList();
        Assert.Equal(5, Assert.Single(filtered).OwnerKey);
        Assert.Throws<InvalidOperationException>(() => MetaObjects.AspNetCore.EfCoreFilterDispatch.ApplyFilter(rows, predicates));

        var bad = MetaObjects.AspNetCore.EfCoreFilterDispatch.Validate<FilterRow>(
            MetaObjects.AspNetCore.FilterParseResult.Ok([new MetaObjects.AspNetCore.FilterPredicate("ownerRef", "eq", "not-a-number")]), map);
        Assert.Equal("invalid_filter_value", bad.ErrorEnvelope);
    }
}
