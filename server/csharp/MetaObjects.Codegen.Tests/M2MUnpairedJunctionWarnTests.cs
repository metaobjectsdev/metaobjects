// M2MUnpairedJunctionWarnTests — a junction M2MDerivation cannot pair is REPORTED,
// not silently dropped (the C# half of the five-port pass; mirrors codegen-ts's
// relation-resolver-m2m-warn.test.ts, commit da1e00266).
//
// M2MNavigationBuilder.Build catches M2MDerivationException and returns null, so a
// relationship whose junction FK columns cannot be derived vanished from the
// generated entity, DbContext and routes with nothing said. The loader's rules never
// check subject pairing, so the model loads clean and `dotnet meta gen` exits 0 —
// the same silent-404 absence class the TPH mounts exist to end, now with mount
// sites that can silently drop.
//
// The skip itself is deliberate (a model that loads must keep building — widening
// the derivation's subject set would make the "must declare one identity.reference
// to ..." error unfalsifiable), so the contract is VISIBILITY, not failure:
// For/Build take an optional warn channel and report every un-pairable junction
// with the derivation's own reason; callers without a channel keep the silent skip.
//
// Both un-pairable corners in one TPH hierarchy:
//   - Auth (base) declares "tags", whose junction reference names the SUBTYPE —
//     un-pairable on the base's walk, but DERIVED by BridgeAuth's (both subject
//     names are in the set), so the subtype keeps its navigation and its mount;
//   - BridgeAuth (subtype) declares "bridgeTags", whose junction reference names
//     the declaring BASE — the derivation's documented carve-out: the base is
//     neither the declaring nor the navigating entity of that walk.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class M2MUnpairedJunctionWarnTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::authw", "children": [
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags_w" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths_w" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "type", "@values": ["Bridge"] } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "relationship.association": { "name": "bridgeTags", "@cardinality": "many", "@objectRef": "Tag", "@through": "BridgeAuthTag" } }
      ]}},
      { "object.entity": { "name": "AuthTag", "children": [
        { "source.rdb": { "@table": "auth_tags_w" } },
        { "field.long": { "name": "authId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["authId", "tagId"] } },
        { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "BridgeAuth" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}},
      { "object.entity": { "name": "BridgeAuthTag", "children": [
        { "source.rdb": { "@table": "bridge_auth_tags_w" } },
        { "field.long": { "name": "bridgeAuthId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["bridgeAuthId", "tagId"] } },
        { "identity.reference": { "name": "fkAuth", "@fields": "bridgeAuthId", "@references": "Auth" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m2m-unpaired-warn.json")]);
        // The premise of the defect: nothing about this model fails the loader — the
        // loader never checks subject pairing.
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void Unpairable_junctions_warn_through_the_channel_and_paired_ones_still_derive()
    {
        var root = Load();

        // The base's own walk cannot pair "tags" (the junction names the subtype) —
        // exactly one warning, naming the relationship, the entity, the junction and
        // the derivation's own reason.
        var warnings = new List<string>();
        Assert.Empty(M2MNavigationBuilder.For(root.FindObject("Auth")!, root, warnings.Add));
        var baseWarn = Assert.Single(warnings);
        Assert.Contains("\"tags\"", baseWarn);
        Assert.Contains("\"Auth\"", baseWarn);
        Assert.Contains("\"AuthTag\"", baseWarn);
        Assert.Contains("must declare one identity.reference to", baseWarn);
        Assert.Contains("The model loads, so the run continues", baseWarn);
        Assert.Contains("absent (a 404)", baseWarn);

        // The subtype's walk DERIVES that same relationship (both subject names are in
        // the set) and reports only its own un-pairable one (junction names the BASE).
        warnings.Clear();
        var navs = M2MNavigationBuilder.For(root.FindObject("BridgeAuth")!, root, warnings.Add);
        var derived = Assert.Single(navs);
        Assert.Equal("tags", derived.Name);
        Assert.Equal("authId", derived.SourceField);
        Assert.Equal("tagId", derived.TargetField);
        var subWarn = Assert.Single(warnings);
        Assert.Contains("\"bridgeTags\"", subWarn);
        Assert.Contains("\"BridgeAuth\"", subWarn);
        Assert.Contains("\"BridgeAuthTag\"", subWarn);
        Assert.Contains("must declare one identity.reference to", subWarn);
        Assert.Contains("absent (a 404)", subWarn);
    }

    [Fact]
    public void Without_a_channel_the_skip_stays_silent()
    {
        var root = Load();
        Assert.Empty(M2MNavigationBuilder.For(root.FindObject("Auth")!, root));
        Assert.DoesNotContain(
            M2MNavigationBuilder.For(root.FindObject("BridgeAuth")!, root),
            n => n.Name == "bridgeTags");
    }

    [Fact]
    public void Full_gen_run_warns_and_still_generates()
    {
        var root = Load();
        var warnings = new List<string>();
        var ctx = new GenContext
        {
            Entities = root.Objects(), Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
            Warn = warnings.Add,
        };

        // The run completes and emits its artifacts — a warning, never an error, never
        // a thrown build failure.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();
        Assert.Contains(files, f => f.Path == "AuthRoutes.g.cs");
        Assert.Contains(files, f => f.Path == "BridgeAuth.g.cs");

        // Both un-pairable junctions are named — the base's through the TPH base-mount
        // walk, the subtype's through the per-subtype mount walk (each also walked by
        // the entity/DbContext generators).
        Assert.Contains(warnings, w => w.Contains("\"tags\"") && w.Contains("\"AuthTag\"") && w.Contains("absent (a 404)"));
        Assert.Contains(warnings, w => w.Contains("\"bridgeTags\"") && w.Contains("\"BridgeAuthTag\"") && w.Contains("absent (a 404)"));

        var routes = files.Single(f => f.Path == "AuthRoutes.g.cs").Content;
        // The DERIVED relationship still mounts, at the base and under the subtype.
        Assert.Contains("/{id}/tags\"", routes);
        Assert.Contains("/bridge/{id}/tags\"", routes);
        // The un-pairable one mounts nothing anywhere.
        Assert.DoesNotContain("bridgeTags", routes);
    }
}
