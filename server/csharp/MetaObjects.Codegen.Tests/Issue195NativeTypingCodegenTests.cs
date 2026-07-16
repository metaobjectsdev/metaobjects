using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// #195 native typing — the projection read-schema nullability precision for the new
// origins. A field derived by origin.aggregate @agg:any|all|collect is COALESCE-
// guaranteed non-null in the synthesized view (any→false, all→true, collect→[]), so
// its CLR read type is non-null even when not @required; origin.first stays nullable
// (empty related set → null); origin.computed keeps the conservative nullable default.
//
// C# parity port of the TS reference (codegen-ts column-mapper.originGuaranteedNonNull
// + projection-decl golden, commit aff49ce6).
public class Issue195NativeTypingCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Session", "children": [
        { "source.rdb": { "@table": "sessions" } },
        { "field.long": { "name": "id" } },
        { "relationship.association": { "name": "turns", "@objectRef": "Turn", "@cardinality": "many" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Turn", "children": [
        { "source.rdb": { "@table": "turns" } },
        { "field.long": { "name": "id" } },
        { "field.boolean": { "name": "success" } },
        { "field.string": { "name": "label" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "SessionSummary", "children": [
        { "source.rdb": { "@kind": "view", "@view": "v_session" } },
        { "field.long": { "name": "id", "extends": "Session.id" } },
        { "field.boolean": { "name": "hasError", "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } }
        ]}},
        { "field.string": { "name": "labels", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": true } }
        ]}},
        { "field.string": { "name": "latestLabel", "children": [
          { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } }
        ]}},
        { "field.boolean": { "name": "hasId", "children": [
          { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "id" } } } }
        ]}},
        { "identity.primary": { "name": "id", "extends": "Session.id" } }
      ]}}
    ]}}
    """;

    private static string ProjectionClass()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "proj.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        return new EntityGenerator().Generate(ctx).Single(f => f.Path == "SessionSummary.g.cs").Content;
    }

    [Fact]
    public void Any_boolean_projection_field_is_non_null()
    {
        var cls = ProjectionClass();
        // any → COALESCE(false) → non-null bool (NOT bool?), even though not @required.
        Assert.Contains("public bool HasError", cls);
        Assert.DoesNotContain("public bool? HasError", cls);
    }

    [Fact]
    public void Collect_projection_field_is_a_non_null_collection()
    {
        var cls = ProjectionClass();
        // collect → COALESCE([]) → non-null List (never a nullable collection).
        Assert.Contains("public ICollection<string> Labels { get; set; } = new List<string>();", cls);
    }

    [Fact]
    public void First_projection_field_stays_nullable()
    {
        var cls = ProjectionClass();
        // first → empty related set selects no row → null.
        Assert.Contains("public string? LatestLabel", cls);
    }

    [Fact]
    public void Computed_projection_field_stays_conservative_nullable()
    {
        var cls = ProjectionClass();
        // computed nullability is expression-dependent → conservative nullable default.
        Assert.Contains("public bool? HasId", cls);
    }
}
