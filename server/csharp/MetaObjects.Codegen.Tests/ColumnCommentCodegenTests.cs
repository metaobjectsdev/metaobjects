// Item 4 and ruling R59: every column a description reaches carries its comment in the EF model.
// A field.map is a converted scalar property and takes SetComment like any column, found with
// GetProperty (a property the generator configures and cannot find is a bug, said loudly). A
// field.object stored as JSON (ToJson) cannot carry a comment in EF 8, so the text — the field's
// @description, else its value object's — rides on the owned type as an annotation that the
// generated design-time differ scaffolds as COMMENT ON COLUMN (live test: EfModelGapsTests).

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ColumnCommentCodegenTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Meta", "@description": "Free-form tags.", "children": [ { "field.string": { "name": "tag" } } ] } },
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.string": { "name": "code", "@maxLength": 20 } },
            { "field.object": { "name": "meta", "@objectRef": "Meta", "@storage": "jsonb" } },
            { "field.map": { "name": "labels", "@valueType": "string", "@description": "Labels by key." } },
            { "identity.primary": { "@fields": "code", "@generation": "assigned" } }
          ] } }
        ] } }
        """;

    private static (List<EmittedFile> Files, List<string> Warnings) Run(string? dialect, DbContextGenerator? generator = null)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m.json")]);
        Assert.Empty(load.Errors);
        var warnings = new List<string>();
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Warn = warnings.Add,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme", Dialect = dialect, ContextAssemblyName = "Acme.Data" },
        };
        return ((generator ?? new DbContextGenerator()).Generate(ctx).ToList(), warnings);
    }

    [Fact]
    public void A_map_takes_its_comment_through_GetProperty()
    {
        var (files, _) = Run("postgres");
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("modelBuilder.Entity<global::Acme.Ticket>().Metadata.GetProperty(\"Labels\").SetComment(\"Labels by key.\");", context);
        Assert.DoesNotContain("FindProperty(", context);
    }

    [Fact]
    public void A_json_column_takes_its_value_objects_description_as_an_annotation_the_design_time_differ_scaffolds()
    {
        var (files, warnings) = Run("postgres");
        // Its outDir is no project on disk, so only the I4 "cannot tell" reference warning is expected.
        Assert.Empty(warnings.Where(w => !w.Contains("cannot tell whether EF reads the DesignTimeServicesReference", StringComparison.Ordinal)));
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("modelBuilder.Entity<global::Acme.Ticket>().Metadata.FindNavigation(\"Meta\")!.TargetEntityType" +
            ".SetAnnotation(\"MetaObjects:JsonColumnComment\", \"Free-form tags.\");", context);
        // No increment key here: the services are emitted for the comment alone.
        var services = Assert.Single(files, f => f.Path.EndsWith("DesignTimeServices.g.cs", StringComparison.Ordinal)).Content;
        Assert.Contains("COMMENT ON COLUMN", services);
    }

    [Fact]
    public void Off_postgres_a_json_column_comment_is_said_and_left_to_meta_migrate()
    {
        var (files, warnings) = Run("sqlite");
        Assert.DoesNotContain("MetaObjects:JsonColumnComment", files.Single(f => f.Path == "AppDbContext.g.cs").Content);
        Assert.Contains(warnings, w => w.Contains("Ticket.meta is not in the EF model", StringComparison.Ordinal));
    }

    // G1, rc.20: an OwnedTypeConfig override decides the mapping, and the comment follows it.
    private sealed class Hook(string line) : DbContextGenerator
    {
        protected override string? OwnedTypeConfig(string owner, MetaObjects.Meta.MetaObject entity, MetaObjects.Meta.MetaField field, GenContext ctx) =>
            field.Name == "meta" ? line.Replace("__OWNER__", owner) : base.OwnedTypeConfig(owner, entity, field, ctx);
    }

    [Fact]
    public void A_json_column_a_hook_maps_as_a_property_takes_its_comment_through_GetProperty()
    {
        var (files, warnings) = Run("postgres", new Hook(
            "        modelBuilder.Entity<__OWNER__>().Property(x => x.Meta).HasColumnName(\"meta\").HasColumnType(\"jsonb\");"));
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("modelBuilder.Entity<global::Acme.Ticket>().Metadata.GetProperty(\"Meta\").SetComment(\"Free-form tags.\");", context);
        Assert.DoesNotContain("FindNavigation(", context);
        Assert.DoesNotContain("MetaObjects:JsonColumnComment", context);
        // No JSON-column annotation, so no design-time services for it.
        Assert.DoesNotContain(files, f => f.Path.EndsWith("DesignTimeServices.g.cs", StringComparison.Ordinal));
        Assert.DoesNotContain(warnings, w => w.Contains("Ticket.meta", StringComparison.Ordinal));
    }

    [Fact]
    public void A_json_column_a_hook_maps_some_other_way_gets_no_comment_line_and_is_said()
    {
        var (files, warnings) = Run("postgres", new Hook("        modelBuilder.Entity<__OWNER__>().Ignore(x => x.Meta);"));
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.DoesNotContain("Free-form tags.", context);
        Assert.Contains(warnings, w => w.Contains("Ticket.meta is not in the EF model", StringComparison.Ordinal)
            && w.Contains("OwnedTypeConfig", StringComparison.Ordinal));
    }

    [Fact]
    public void A_hook_that_keeps_the_stock_owned_mapping_keeps_the_annotation_byte_for_byte()
    {
        var (stock, _) = Run("postgres");
        // The hook returns the stock line itself, as an override that delegates to base does.
        var owned = stock.Single(f => f.Path == "AppDbContext.g.cs").Content.Split('\n')
            .Single(l => l.Contains("OwnsOne(x => x.Meta", StringComparison.Ordinal)).TrimEnd('\r');
        Assert.Contains(".ToJson(", owned);
        var (hooked, _) = Run("postgres", new Hook(owned));
        Assert.Equal(stock.Single(f => f.Path == "AppDbContext.g.cs").Content, hooked.Single(f => f.Path == "AppDbContext.g.cs").Content);
    }
}
