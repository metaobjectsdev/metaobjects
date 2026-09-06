// IndexNaming.ResolveIndexName — the ONE door an index's database name comes through.
//
// C# port of the TS reference's resolve-index-name.test.ts. Both arms are asserted
// DELIBERATELY: "the loader already handles it" is the belief that would delete the
// empty-name refusal, and it is true of exactly ONE of the two node types.
//
//   - an `identity.secondary` with an empty name is refused by the LOADER (identity nodes
//     carry an FR-024 name check so a dotted `extends` ref can address them);
//   - an `index.lookup` is not addressable that way and carries no such check, so it loads
//     with ZERO errors and reaches the emitters.
//
// The measurement is the point. Without it the refusal looks redundant.

using MetaObjects.Loader;
using MetaObjects.Meta;
using static MetaObjects.Core.Index.IndexConstants;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ResolveIndexNameTests
{
    private static LoadResult Load(string json) =>
        new MetaDataLoader(FullCoreRegistry.Compose()).Load(
            [new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "index-name.json")]);

    private static string Model(string secondaryName, string lookupName) => """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "code" } },
        { "identity.primary":   { "name": "pk", "@fields": ["id"] } },
        { "identity.secondary": { "name": "__SEC__", "@fields": ["code"] } },
        { "index.lookup":       { "name": "__LKP__", "@fields": ["code"] } }
      ]}}
    ]}}
    """.Replace("__SEC__", secondaryName).Replace("__LKP__", lookupName);

    private static MetaObject Widget(LoadResult r) => r.Root.Objects().Single(o => o.Name == "Widget");

    [Fact]
    public void The_database_name_of_a_secondary_identity_and_a_lookup_index_is_its_metamodel_name()
    {
        var r = Load(Model("uq_widget_code", "ix_widget_code"));
        Assert.Empty(r.Errors);
        var w = Widget(r);

        var secondary = w.SecondaryIdentities().Single();
        Assert.Equal("uq_widget_code", IndexNaming.ResolveIndexName(secondary));

        var lookup = w.LookupIndexes().Single();
        Assert.Equal("ix_widget_code", IndexNaming.ResolveIndexName(lookup));
    }

    [Fact]
    public void A_package_qualifier_is_stripped()
    {
        // A no-op on input THIS port produces, which is the point: the JVM loader spells a
        // nested index name package-qualified (`acme::demo::by_name`), and doing the strip at
        // the shared door makes the ports' answer one rule rather than several habits.
        var node = new MetaIndex(new TypeId(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP), "acme::demo::by_name");
        Assert.Equal("by_name", IndexNaming.ResolveIndexName(node));
    }

    [Fact]
    public void An_empty_index_lookup_name_LOADS_CLEAN_and_is_refused_at_the_door()
    {
        // Arm 1 — the gap is real. An `index.lookup` carries no loader name check, so this
        // model passes every gate and reaches the emitters.
        var r = Load(Model("uq_widget_code", ""));
        Assert.Empty(r.Errors);

        var lookup = Widget(r).LookupIndexes().Single();
        var ex = Assert.Throws<InvalidOperationException>(() => IndexNaming.ResolveIndexName(lookup));
        Assert.Contains("empty name", ex.Message);
        Assert.Contains("index.lookup", ex.Message);
    }

    [Fact]
    public void An_empty_identity_secondary_name_is_refused_by_the_LOADER_already()
    {
        // Arm 2 — and this is why the refusal above cannot be justified by "the loader
        // handles it". For an identity it does; for a lookup index it does not.
        var r = Load(Model("", "ix_widget_code"));
        Assert.NotEmpty(r.Errors);
    }
}
