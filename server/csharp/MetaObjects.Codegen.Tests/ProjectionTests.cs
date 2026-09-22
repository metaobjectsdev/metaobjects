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
      { "object.entity": { "name": "Program", "children": [
        { "source.rdb": { "@kind": "table", "@table": "programs" } },
        { "field.long": { "name": "id" } },
        { "field.int":  { "name": "weekCount" } },
        { "identity.primary": { "name": "pk", "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "ProgramSummary", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
        { "field.long": { "name": "id", "extends": "Program.id" } },
        { "field.int":  { "name": "weekCount" } },
        { "identity.primary": { "name": "pk", "extends": "Program.pk" } }
      ]}},
      { "object.projection": { "name": "TagCount", "children": [
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
        // IncludeNames: true -- the ToView(...Names.SourcePrimaryView) assertions below need the
        // db-context generator to reference the names artifact; GenConfig.IncludeNames
        // defaults to false.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
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
        // keyed projection: ToView, no HasNoKey. §A6 (task 4) — references the
        // projection's own <Name>Names.SourcePrimaryView constant -- the member is named for
        // the source's @kind, so a view name cannot be read out of a table slot.
        Assert.Contains("modelBuilder.Entity<ProgramSummary>().ToView(ProgramSummaryNames.SourcePrimaryView);", src);
        // keyless projection: HasNoKey + ToView
        Assert.Contains("modelBuilder.Entity<TagCount>().HasNoKey().ToView(TagCountNames.SourcePrimaryView);", src);
    }

    [Fact]
    public void Projection_routes_are_read_only()
    {
        var ctx = Ctx(Load());
        var src = new RoutesGenerator().Generate(ctx)
            .Single(f => f.Path == "ProgramSummaryRoutes.g.cs").Content;
        // GET list takes HttpContext (qs handling per api-contract.md).
        Assert.Contains("app.MapGet(prefix + \"/program_summaries\", async (HttpContext http, AppDbContext db) =>", src);
        Assert.Contains("app.MapGet(prefix + \"/program_summaries/{id}\"", src); // keyed -> readable by id
        // No write HANDLER anywhere: the verbs are mounted (see the test below), but
        // every one of them is a refusal, so nothing in this file can persist a row.
        Assert.DoesNotContain("SaveChangesAsync", src);
        Assert.DoesNotContain("Results.Created", src);
        Assert.DoesNotContain(".Remove(", src);
    }

    // F22 — the write verbs are MOUNTED on a projection, and every one answers the
    // cross-port 405 envelope. Mounting them is the point: left unmounted, ASP.NET
    // answers a POST on a path it knows with its own empty-bodied 405, which is a
    // fifth body shape on a wire the other four ports spell one way.
    [Fact]
    public void Projection_write_verbs_answer_the_405_envelope()
    {
        var ctx = Ctx(Load());
        var src = new RoutesGenerator().Generate(ctx)
            .Single(f => f.Path == "ProgramSummaryRoutes.g.cs").Content;
        Assert.Contains("app.MapPost(prefix + \"/program_summaries\", () =>", src);
        Assert.Contains("app.MapPatch(prefix + \"/program_summaries/{id}\", (long id) =>", src);
        Assert.Contains("app.MapPut(prefix + \"/program_summaries/{id}\", (long id) =>", src);
        Assert.Contains("app.MapDelete(prefix + \"/program_summaries/{id}\", (long id) =>", src);
        // Four refusals, each carrying the asserted envelope member.
        Assert.Equal(4, src.Split("error = \"method_not_allowed\"").Length - 1);
        Assert.Equal(4, src.Split("statusCode: 405").Length - 1);
    }

    // A KEYLESS projection mounts no /{id} read, so it refuses only the collection
    // verb: a PATCH /{id} refusal would advertise an address the port never serves.
    [Fact]
    public void Keyless_projection_refuses_only_the_collection_verb()
    {
        var ctx = Ctx(Load());
        var src = new RoutesGenerator().Generate(ctx)
            .Single(f => f.Path == "TagCountRoutes.g.cs").Content;
        Assert.DoesNotContain("app.MapGet(prefix + \"/tag_counts/{id}\"", src);
        Assert.Contains("app.MapPost(prefix + \"/tag_counts\", () =>", src);
        Assert.DoesNotContain("app.MapPatch", src);
        Assert.DoesNotContain("app.MapPut", src);
        Assert.DoesNotContain("app.MapDelete", src);
    }
}
