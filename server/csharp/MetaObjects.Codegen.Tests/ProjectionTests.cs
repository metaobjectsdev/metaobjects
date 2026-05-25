using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Read-only projection codegen (source.dbView): entities map to a view (no
/// [Table]; .ToView in the DbContext), keyless projections get .HasNoKey, and
/// routes are read-only (no POST/PUT/DELETE).
/// </summary>
public class ProjectionTests
{
    // ProgramSummary: keyed projection (dbView + primary id).
    // TagCount: keyless projection (dbView, no identity).
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "ProgramSummary", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
        { "field.long": { "name": "id" } },
        { "field.int":  { "name": "weekCount" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "TagCount", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_tag_count" } },
        { "field.string": { "name": "tag" } },
        { "field.int":    { "name": "count" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "proj.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static string EntitySrc(GenContext ctx, string name) =>
        new EntityGenerator().Generate(ctx).Single(f => f.Path == name + ".g.cs").Content;

    [Fact]
    public void Keyed_projection_maps_to_view_not_table()
    {
        var src = EntitySrc(Ctx(Load()), "ProgramSummary");
        Assert.DoesNotContain("[Table(", src);          // projections are views, not tables
        Assert.Contains("[Key]", src);                  // keyed by its primary identity
        Assert.Contains("public long Id { get; set; }", src);
        Assert.Contains("public int? WeekCount { get; set; }", src);
    }

    [Fact]
    public void Keyless_projection_has_no_table_and_no_key()
    {
        var src = EntitySrc(Ctx(Load()), "TagCount");
        Assert.DoesNotContain("[Table(", src);
        Assert.DoesNotContain("[Key]", src);
    }

    [Fact]
    public void DbContext_maps_views_and_marks_keyless()
    {
        var file = Assert.Single(new DbContextGenerator().Generate(Ctx(Load())));
        var src = file.Content;
        Assert.Contains("protected override void OnModelCreating(ModelBuilder modelBuilder)", src);
        // keyed projection: ToView, no HasNoKey
        Assert.Contains("modelBuilder.Entity<ProgramSummary>().ToView(\"v_program_summary\");", src);
        // keyless projection: HasNoKey + ToView
        Assert.Contains("modelBuilder.Entity<TagCount>().HasNoKey().ToView(\"v_tag_count\");", src);
    }

    [Fact]
    public void Projection_routes_are_read_only()
    {
        var ctx = Ctx(Load());
        var src = new RoutesGenerator().Generate(ctx)
            .Single(f => f.Path == "ProgramSummaryRoutes.g.cs").Content;
        Assert.Contains("app.MapGet(prefix + \"/programsummaries\", async (AppDbContext db) =>", src);
        Assert.Contains("app.MapGet(prefix + \"/programsummaries/{id}\"", src); // keyed -> readable by id
        Assert.DoesNotContain("app.MapPost", src);    // read-only: no writes
        Assert.DoesNotContain("app.MapPut", src);
        Assert.DoesNotContain("app.MapDelete", src);
    }
}
