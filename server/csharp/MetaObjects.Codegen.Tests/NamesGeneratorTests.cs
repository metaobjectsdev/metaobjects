// NamesGeneratorTests — exercises the per-object physical database name constants
// (spec A1/A2/A3/A6):
//
//  - const string members for kind/name/schema/readOnly + per-field Field/Column pairs,
//    always both, so a Field/Column collision (createdAt/created_at) can never collapse
//    to one constant.
//  - An explicit @column always wins over the naming strategy — never a hand-rolled
//    re-derivation. The model carries a field whose @column deliberately is NOT the
//    snake_case of its name (callPurpose/purpose_code): without that field, neither arm
//    of the resolver (explicit vs. strategy-derived) is distinguished from the other,
//    which is the exact coverage gap that hid an earlier defect in this codebase.
//  - Schema line omitted (never emitted null) when undeclared, present when declared.
//  - #248: an object with no primary source emits nothing — participation is never
//    gated on the object subtype.
//  - Two fields colliding on their Pascal member name is refused, naming the model.
//  - R-B/R-C: a primary source that disagrees with the primary WRITABLE source
//    (reachable via an abstract parent's own differently-named primary source plus a
//    child's own, differently-named, writable primary source — see CSharpNaming.
//    ResolveObjectNames) is refused, naming the object and BOTH names. There is no
//    fallback-to-literal: every consumption site references the resolved constant
//    unconditionally, so a name that cannot be agreed on must be a build error.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class NamesGeneratorTests
{
    private static GenContext Ctx(MetaRoot root, ColumnNamingStrategy strategy = ColumnNamingStrategy.SnakeCase) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = strategy },
    };

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    // Subscriber carries the two distinguishing fields:
    //  - createdAt: no @column — the snake_case strategy alone produces "created_at",
    //    proving the Field/Column pair is emitted even when the model names nothing
    //    explicitly (the createdAt/created_at collision the shape exists for).
    //  - callPurpose: an EXPLICIT @column: "purpose_code" that the snake_case strategy
    //    would NOT have produced ("call_purpose") — the resolver-vs-hand-rolled-transform
    //    discriminator this test suite requires.
    // AddressValue has no source at all (object.value — FR-024 value purity forbids one).
    private const string SubscriberModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":      { "name": "id" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "field.string":    { "name": "callPurpose", "@column": "purpose_code" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "AddressValue", "children": [
        { "field.string": { "name": "street" } }
      ]}}
    ]}}
    """;

    private static string SubscriberSource() =>
        Assert.Single(new NamesGenerator().Generate(Ctx(Load(SubscriberModel)))).Content;

    [Fact]
    public void Emits_const_string_members_for_table_and_columns()
    {
        var src = SubscriberSource();

        Assert.Contains("public static class SubscriberNames", src);
        Assert.Contains("public const string Kind = \"table\";", src);
        Assert.Contains("public const string Name = \"subscribers\";", src);
        Assert.Contains("public const bool ReadOnly = false;", src);

        // Both names, always, always distinguished. createdAt/created_at is the
        // collision that makes the pair non-optional.
        Assert.Contains("public const string CreatedAtField = \"createdAt\";", src);
        Assert.Contains("public const string CreatedAtColumn = \"created_at\";", src);
    }

    [Fact]
    public void An_explicit_column_wins_over_the_naming_strategy()
    {
        // callPurpose carries @column: "purpose_code". A re-derivation under the
        // configured snake_case strategy would say "call_purpose"; only the resolver
        // (CSharpNaming.Column, which checks @column first) says "purpose_code".
        var src = SubscriberSource();
        Assert.Contains("public const string CallPurposeColumn = \"purpose_code\";", src);
        Assert.DoesNotContain("call_purpose", src);
    }

    [Fact]
    public void ColumnsByField_map_references_the_constants_not_repeated_literals()
    {
        // The artifact must not spell a physical name twice inside itself.
        var src = SubscriberSource();
        Assert.Contains("[\"callPurpose\"] = CallPurposeColumn,", src);
        Assert.Contains("[\"createdAt\"] = CreatedAtColumn,", src);
        Assert.Contains("[\"id\"] = IdColumn,", src);
    }

    [Fact]
    public void Schema_line_is_omitted_when_undeclared()
    {
        Assert.DoesNotContain("public const string Schema", SubscriberSource());
    }

    [Fact]
    public void Schema_line_is_emitted_when_declared()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb": { "@table": "widgets", "@schema": "inventory" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        Assert.Contains("public const string Schema = \"inventory\";", src);
    }

    [Fact]
    public void A_view_kind_source_is_read_only_and_keeps_its_own_kind()
    {
        // resolveObjectNames dispatches on the primary source's kind, never the object
        // subtype (#248) — a projection with a read-only primary source exercises the
        // ReadOnly branch legally (FR-024/ADR-0028 requires an object.entity's primary
        // source to be writable; a derived read model is an object.projection).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "Report", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_report" } },
            { "field.int": { "name": "id" } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        Assert.Contains("public const string Kind = \"view\";", src);
        Assert.Contains("public const string Name = \"v_report\";", src);
        Assert.Contains("public const bool ReadOnly = true;", src);
    }

    [Fact]
    public void An_object_with_no_primary_source_emits_nothing()
    {
        // #248 — participation in the database derives from a declared primary source,
        // never from the object subtype. AddressValue (object.value) has no source at
        // all and must not appear in the output.
        var files = new NamesGenerator().Generate(Ctx(Load(SubscriberModel))).ToList();
        var file = Assert.Single(files);
        Assert.Equal("SubscriberNames.g.cs", file.Path);
    }

    [Fact]
    public void Two_fields_colliding_on_their_Pascal_form_is_refused_naming_the_model()
    {
        // userId and UserId both Pascalize to "UserId" — two duplicate const members.
        // C# would refuse to compile the generated file, but the error would name a
        // generated .g.cs and read as a codegen bug rather than a model one. Fail here
        // instead, naming the entity and both offending field names.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Weird", "children": [
            { "source.rdb": { "@table": "weirds" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "userId" } },
            { "field.string": { "name": "UserId" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var ex = Assert.Throws<InvalidOperationException>(
            () => new NamesGenerator().Generate(Ctx(Load(model))).ToList());
        Assert.Contains("Weird", ex.Message);
        Assert.Contains("userId", ex.Message);
        Assert.Contains("UserId", ex.Message);
    }

    [Fact]
    public void A_divergent_primary_and_writable_source_pair_is_refused_naming_both()
    {
        // The REACHABLE divergence (R-C): ValidateOnePrimarySource enforces "exactly
        // one primary" over OWN children only (MetaObjects/Loader/ValidationPasses.cs),
        // and effective-children shadowing (MetaData.EffectiveChildren) matches an own
        // child over a super child only on a (type, name) match. Two source.rdb children
        // with DIFFERENT explicit names never collide, so ParentWeird's own read-only
        // primary source and ChildWeird's own, differently-named, writable primary
        // source both survive on ChildWeird's effective Sources() at once — this loads
        // with ZERO errors. CSharpNaming.ResolveObjectNames's looser
        // FirstOrDefault(role==primary) returns the first (inherited, read-only) one;
        // MetaObject.DbTable's stricter (role==primary && IsWritable()) skips it and
        // matches the later, writable one. Two real, different, defined strings.
        //
        // object.base (not object.entity): FR-024/ADR-0028's ERR_ENTITY_PRIMARY_SOURCE_
        // READONLY forbids a read-only primary source on an object.entity outright,
        // which would trip before this check ever ran. object.base carries no
        // subtype-specific validation ("a template — no rule"), so this shape loads.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.base": { "name": "ParentWeird", "abstract": true, "children": [
            { "source.rdb": { "name": "viewSrc", "@kind": "view", "@view": "v_parent", "@role": "primary" } },
            { "field.int": { "name": "id" } }
          ]}},
          { "object.base": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
            { "source.rdb": { "name": "tableSrc", "@table": "child_table", "@role": "primary" } }
          ]}}
        ]}}
        """;
        var root = Load(model);
        var child = root.Objects().Single(o => o.Name == "ChildWeird");
        // Documents the shape: two real, different, defined strings — not a null vs. a
        // string (contrast the "read-only primary beside a writable replica on ONE
        // object" shape, where dbTable resolves to null and there is nothing to
        // disagree ABOUT).
        Assert.Equal("child_table", child.DbTable);

        var ex = Assert.Throws<InvalidOperationException>(
            () => new NamesGenerator().Generate(Ctx(root)).ToList());
        // All three substrings asserted separately, so a message that drops one still fails.
        Assert.Contains("ChildWeird", ex.Message);
        Assert.Contains("v_parent", ex.Message);
        Assert.Contains("child_table", ex.Message);
    }
}
