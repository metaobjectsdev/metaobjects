// A reference over a flattened value-object member (`identity.reference @fields: address.countryId`):
// the foreign key is configured on the owned type's builder, and no reverse finder is emitted for
// it (the dotted field is no property of the entity class). The live EF-model check is
// EfModelGapsTests.A_reference_over_a_flattened_member_is_a_foreign_key_of_the_owned_type.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class FlattenedMemberReferenceCodegenTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Country", "children": [
            { "source.rdb": { "@table": "countries" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ] } },
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city" } },
            { "field.long": { "name": "countryId" } }
          ] } },
          { "object.entity": { "name": "Plan", "children": [
            { "source.rdb": { "@table": "plans" } },
            { "field.long": { "name": "id" } },
            { "field.object": { "name": "address", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.reference": { "name": "countryId", "@fields": "address.countryId", "@references": "Country", "@onDelete": "restrict" } }
          ] } }
        ] } }
        """;

    private static (GenContext Ctx, List<string> Warnings) Context(string model)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(load.Errors);
        var warnings = new List<string>();
        return (new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Warn = warnings.Add,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme" },
        }, warnings);
    }

    [Fact]
    public void The_foreign_key_is_configured_on_the_owned_types_builder()
    {
        var (ctx, warnings) = Context(Model);
        var context = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;
        Assert.Contains("modelBuilder.Entity<Plan>().OwnsOne(x => x.Address).HasOne<Country>().WithMany().HasForeignKey(e => e.CountryId)", context);
        Assert.Contains("DeleteBehavior.Restrict", context);
        Assert.Empty(warnings);
    }

    [Fact]
    public void A_reference_over_the_entity_and_a_member_has_no_mapping_and_is_said()
    {
        var model = Model.Replace("\"@fields\": \"address.countryId\"", "\"@fields\": [\"id\", \"address.countryId\"]");
        var (ctx, warnings) = Context(model);
        var context = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;
        Assert.DoesNotContain("OwnsOne(x => x.Address).HasOne", context);
        Assert.Contains(warnings, w => w.Contains("not all members of one flattened value object", StringComparison.Ordinal));
    }

    [Fact]
    public void A_dotted_reference_gets_no_reverse_finder()
    {
        var (ctx, _) = Context(Model);
        var plan = ctx.Root.Objects().Single(o => o.Name == "Plan");
        Assert.Empty(ReverseFinderBuilder.For(plan));
    }
}
