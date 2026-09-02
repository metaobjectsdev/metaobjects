// #248 in the C# port — DB participation derives from a declared/inherited
// `source.rdb`, NEVER from the object subtype.
//
// Five independent gates decided "is this object persisted?" by asking
// `IsEntity() || DbView is not null` and nothing else, so a concrete
// `object.entity` that declares no source at all — which the loader accepts with
// zero errors — got a fabricated `[Table("Ledger")]`, a `DbSet<Ledger>`, CRUD
// routes and a filter allowlist against a table that does not exist and that
// `meta migrate` will never create.
//
// Four of the five route through `InstanceArtifacts.EmitsInstanceArtifacts`, so
// the source check lives THERE (mirroring the TS reference's
// `emitsInstanceArtifacts = !isAbstract && hasAnyRdbSource`). The fifth,
// `EntityGenerator`'s own `mapped` set, keeps emitting the object's SHAPE — as an
// unmapped POCO, exactly as the TS entity-file generator emits an interface + Zod
// schema for a source-less object — because #248 governs DB participation, not
// whether a type exists for an adopter to name.
//
// Abstract objects are deliberately exempt from the source check: they are
// shape-only by definition, and the `BaseEntity` pattern has a shared abstract
// base declare no source of its own.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class SourcelessEntityGatesTests
{
    // Ledger: concrete object.entity, NO source.rdb anywhere (loads with zero errors).
    // Booking: concrete object.entity WITH a source.rdb — the control arm, so every
    // assertion below distinguishes "the gate narrowed" from "the generator emits nothing".
    // AbstractBase: abstract + sourceless — must stay exempt.
    // Booked: extends AbstractBase and declares the source; Derived: extends Booking and
    // INHERITS its source (ADR-0039 resolving — an own-only source read would wrongly
    // classify it as sourceless).
    private const string Model = """
    {
      "metadata.root": {
        "package": "acme::gates",
        "children": [
          { "object.entity": { "name": "Ledger", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "note", "@filterable": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } },
          { "object.entity": { "name": "Booking", "children": [
            { "source.rdb": { "name": "primary", "@table": "bookings" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "@filterable": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } },
          { "object.entity": { "name": "Derived", "extends": "Booking", "children": [
            { "field.string": { "name": "extra" } }
          ] } },
          { "object.entity": { "name": "AbstractBase", "abstract": true, "children": [
            { "field.long": { "name": "id" } }
          ] } }
        ]
      }
    }
    """;

    private static GenContext Ctx(bool emitAbstractShapes = false)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "gates.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig
            {
                OutDir = "/tmp", Namespace = "Acme.Generated", EmitAbstractShapes = emitAbstractShapes,
            },
        };
    }

    private static MetaObject Obj(GenContext ctx, string name) =>
        Assert.Single(ctx.Entities, o => o.Name == name);

    // ---- the shared predicate -------------------------------------------------

    [Fact]
    public void A_sourceless_concrete_entity_emits_no_instance_artifacts()
    {
        var ctx = Ctx();
        Assert.False(InstanceArtifacts.HasAnyRdbSource(Obj(ctx, "Ledger")));
        Assert.False(InstanceArtifacts.EmitsInstanceArtifacts(Obj(ctx, "Ledger")));
    }

    [Fact]
    public void A_sourced_concrete_entity_still_emits_instance_artifacts()
    {
        var ctx = Ctx();
        Assert.True(InstanceArtifacts.HasAnyRdbSource(Obj(ctx, "Booking")));
        Assert.True(InstanceArtifacts.EmitsInstanceArtifacts(Obj(ctx, "Booking")));
    }

    [Fact]
    public void An_entity_that_INHERITS_its_source_via_extends_still_emits_instance_artifacts()
    {
        // ADR-0039: the source check must be RESOLVING. An own-only read here would
        // classify Derived as sourceless and silently delete its table mapping.
        var ctx = Ctx();
        Assert.True(InstanceArtifacts.HasAnyRdbSource(Obj(ctx, "Derived")));
        Assert.True(InstanceArtifacts.EmitsInstanceArtifacts(Obj(ctx, "Derived")));
    }

    // ---- gate 1: EntityGenerator ---------------------------------------------

    [Fact]
    public void Gate1_the_sourceless_entity_keeps_its_SHAPE_but_loses_every_EF_mapping_attribute()
    {
        var ctx = Ctx();
        var files = new EntityGenerator().Generate(ctx).ToList();

        var ledger = Assert.Single(files, f => f.Path == "Ledger.g.cs").Content;
        // The type still exists — an adopter names it, and an object-field may nest it.
        Assert.Contains("public class Ledger", ledger);
        Assert.Contains("public string? Note", ledger);
        // ...but it claims no table, no key and no column: it is not in the database.
        Assert.DoesNotContain("[Table(", ledger);
        Assert.DoesNotContain("[Key]", ledger);
        Assert.DoesNotContain("[Column(", ledger);

        // Control: the sourced entity keeps all of it.
        var booking = Assert.Single(files, f => f.Path == "Booking.g.cs").Content;
        Assert.Contains("[Table(\"bookings\")]", booking);
        Assert.Contains("[Key]", booking);
    }

    [Fact]
    public void Gate1_an_ABSTRACT_sourceless_base_is_exempt_and_still_emits_its_shape()
    {
        // The BaseEntity pattern: a shared abstract base declares no source of its own.
        // Narrowing on the source alone would delete its shape class.
        var ctx = Ctx(emitAbstractShapes: true);
        var files = new EntityGenerator().Generate(ctx).ToList();

        var @base = Assert.Single(files, f => f.Path == "AbstractBase.g.cs").Content;
        Assert.Contains("public abstract class AbstractBase", @base);
    }

    // ---- gate 2 + 3: DbContextGenerator (AppliesTo + the model config) --------

    [Fact]
    public void Gate2_the_sourceless_entity_gets_no_DbSet_and_no_model_configuration()
    {
        var ctx = Ctx();
        Assert.False(DbContextGenerator.AppliesTo(Obj(ctx, "Ledger"), ctx.Root));
        Assert.True(DbContextGenerator.AppliesTo(Obj(ctx, "Booking"), ctx.Root));

        var dbContext = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;
        Assert.DoesNotContain("DbSet<Ledger>", dbContext);
        Assert.DoesNotContain("Entity<Ledger>", dbContext);
        Assert.Contains("DbSet<Booking>", dbContext);
    }

    // ---- gate 4: RoutesGenerator ---------------------------------------------

    [Fact]
    public void Gate4_the_sourceless_entity_gets_no_CRUD_routes()
    {
        var ctx = Ctx();
        Assert.False(RoutesGenerator.AppliesTo(Obj(ctx, "Ledger"), ctx.Root));
        Assert.True(RoutesGenerator.AppliesTo(Obj(ctx, "Booking"), ctx.Root));

        var paths = new RoutesGenerator().Generate(ctx).Select(f => f.Path).ToList();
        Assert.DoesNotContain(paths, p => p.StartsWith("Ledger", StringComparison.Ordinal));
        Assert.Contains(paths, p => p.StartsWith("Booking", StringComparison.Ordinal));
    }

    // ---- gate 5: FilterAllowlistGenerator ------------------------------------

    [Fact]
    public void Gate5_the_sourceless_entity_gets_no_filter_allowlist()
    {
        var ctx = Ctx();
        Assert.False(FilterAllowlistGenerator.AppliesTo(Obj(ctx, "Ledger")));
        Assert.True(FilterAllowlistGenerator.AppliesTo(Obj(ctx, "Booking")));

        var paths = new FilterAllowlistGenerator().Generate(ctx).Select(f => f.Path).ToList();
        Assert.DoesNotContain(paths, p => p.StartsWith("Ledger", StringComparison.Ordinal));
        Assert.Contains(paths, p => p.StartsWith("Booking", StringComparison.Ordinal));
    }
}
