// An own child may be shadowed by its SUPER's child — never by a later own SIBLING.
//
// `EffectiveChildren` writes a shadowing own child straight into `result[idx]`, and the
// entry stays visible to the NEXT own sibling's scan. So a second own child sharing the
// same (Type, Name) finds its own sibling where the super's child used to be and
// overwrites it. `extends` decides what a child overrides; a sibling is not a super.
//
// The append queue already closed the other branch — a non-shadowing own child is
// deferred, so it cannot be matched by a later sibling — and left this one open.
//
// WHY THE SHAPE IS NOT EXOTIC. Two children collide on (Type, Name) most easily when BOTH
// ARE UNNAMED, and the everyday model declaring two unnamed children of one type is a
// WRITE-THROUGH ENTITY: `source.rdb @role: primary` for writes, `source.rdb @role:
// replica` for reads. Give its abstract base a source too — the ordinary way a base states
// the default table for a family — and the entity's own PRIMARY is silently dropped.
// `PrimaryRdbSource` reads the effective children, so the cost is not cosmetic.
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class EffectiveChildrenSiblingShadowingTests
{
    // Both halves are load-bearing: with no super the merge loop never runs, and with only
    // one own source nothing collides. The base declaring its OWN source is what makes the
    // first own source take the replace branch rather than the append queue.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long":  { "name": "id" } },
        { "source.rdb":  { "@table": "acct_tbl", "@role": "primary" } }
      ] } },
      { "object.entity": { "name": "Acct", "extends": "Base", "children": [
        { "source.rdb":       { "@table": "acct_tbl", "@role": "primary" } },
        { "source.rdb":       { "@kind": "view", "@view": "acct_vw", "@role": "replica" } },
        { "field.string":     { "name": "memo" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ] } }
    ] } }
    """;

    private static MetaObject Acct()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "wt.json")]);
        Assert.Empty(r.Errors);
        return r.Root.Objects().Single(o => o.Name == "Acct");
    }

    [Fact]
    public void A_write_through_entity_over_a_sourced_base_keeps_both_of_its_own_sources()
    {
        var roles = Acct().Children()
            .Where(c => c.Type == "source")
            .Select(c => ((MetaSource)c).Role)
            .OrderBy(r => r, StringComparer.Ordinal)
            .ToList();
        // Before the fix this was ["replica"] — the entity's own primary replaced the
        // base's source, and then its own sibling replaced IT, so an object declaring two
        // sources resolved to one.
        Assert.Equal(new[] { "primary", "replica" }, roles);
    }

    [Fact]
    public void So_its_primary_source_still_resolves()
    {
        var src = SourceResolution.PrimaryRdbSource(Acct());
        Assert.NotNull(src);
        Assert.Equal("acct_tbl", src!.PhysicalName);
    }
}
