// NamesGeneratorTests — exercises the per-object physical database name constants
// (spec A1/A2/A3/A6):
//
//  - The artifact MIRRORS THE METADATA TREE: the object's own type/subType/name, then one
//    member group per source keyed by @role with the physical name under the alias for its
//    @kind (SourcePrimaryTable / SourceReplicaView / SourcePrimaryProc), then per-field
//    Field/Column pairs — always both, so a Field/Column collision (createdAt/created_at)
//    can never collapse to one constant — then identities and indexes.
//  - `ReadOnly` is GONE. It was never metadata: it is a derivation over @kind
//    (MetaSource.IsReadOnly), and a sweep of all five ports found zero consumers. A reader
//    who wants read-only-ness asks SourcePrimaryKind, which is what the author wrote.
//  - An explicit @column always wins over the naming strategy — never a hand-rolled
//    re-derivation. The model carries a field whose @column deliberately is NOT the
//    snake_case of its name (callPurpose/purpose_code): without that field, neither arm
//    of the resolver (explicit vs. strategy-derived) is distinguished from the other,
//    which is the exact coverage gap that hid an earlier defect in this codebase.
//  - Schema line omitted (never emitted null) when undeclared, present when declared.
//  - #248: an object with no primary source emits nothing — participation is never
//    gated on the object subtype.
//  - Two nodes colliding on their constant member name is refused, naming BOTH nodes. The
//    guard is over the artifact's whole emitted member set, not per-collection: four node
//    kinds now share one flat namespace.
//  - R-B/R-C: an object whose @role: primary sources disagree on a physical name
//    (reachable via an abstract parent's own differently-named primary source plus a
//    child's own, differently-named one — see MetaObjects.Meta.SourceResolution, which
//    owns the refusal for codegen AND runtime) is refused, naming the object and BOTH
//    names. There is no
//    fallback-to-literal: every consumption site references the resolved constant
//    unconditionally, so a name that cannot be agreed on must be a build error.

using MetaObjects.Cli;
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
        // IncludeNames: true -- this is the ON-arm helper (see CtxWithoutNames below for
        // the OFF arm); GenConfig.IncludeNames defaults to false, so the Task-4
        // consumption-site assertions below need it set explicitly.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = strategy, IncludeNames = true },
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

        // `abstract class`, not `static class`: a static class can neither inherit nor be
        // inherited, and a names artifact now extends its parent's rather than restating it.
        // Abstract keeps the "never instantiate" guarantee; a const is still inherited, so
        // every consumption site is unchanged.
        Assert.Contains("public abstract class SubscriberNames", src);

        // The object's OWN identity. `Name` held the PHYSICAL name until 0.25.0 — the one
        // change here a hand-written consumer adopts without a compile error, which is why
        // it is asserted rather than assumed.
        Assert.Contains("public const string Type = \"object\";", src);
        Assert.Contains("public const string SubType = \"entity\";", src);
        Assert.Contains("public const string Name = \"Subscriber\";", src);

        // The source, under the role it plays, with the physical name under the alias for
        // its @kind. `SubscriberNames.SourcePrimaryView` does not exist, and that is the
        // point: the read site answers "table or view?" instead of the reader having to.
        Assert.Contains("public const string SourcePrimaryType = \"source\";", src);
        Assert.Contains("public const string SourcePrimarySubType = \"rdb\";", src);
        Assert.Contains("public const string SourcePrimaryKind = \"table\";", src);
        Assert.Contains("public const string SourcePrimaryTable = \"subscribers\";", src);
        Assert.DoesNotContain("SourcePrimaryView", src);

        // ReadOnly is not relocated — it is REMOVED. A derivation over @kind is not metadata,
        // and an artifact that mirrors the tree carries what was declared.
        Assert.DoesNotContain("ReadOnly", src);

        // The identity, carrying its own type/subType/name. No `Index` member: no database
        // name exists for a primary key to carry (migrate hardcodes <table>_pkey on Postgres
        // and emits an unnamed PK on SQLite), and carrying one would restate a migrate-only
        // dialect-conditional formula in the artifact built to stop exactly that.
        Assert.Contains("public const string IdentityPrimaryType = \"identity\";", src);
        Assert.Contains("public const string IdentityPrimarySubType = \"primary\";", src);
        Assert.Contains("public const string IdentityPrimaryName = \"primary\";", src);
        Assert.DoesNotContain("IdentityPrimaryIndex", src);

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
        Assert.DoesNotContain("Schema", SubscriberSource());
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
        Assert.Contains("public const string SourcePrimarySchema = \"inventory\";", src);
    }

    [Fact]
    public void A_view_kind_source_carries_its_name_under_the_view_alias()
    {
        // ResolveObjectNames dispatches on the primary source's kind, never the object
        // subtype (#248) — a projection with a read-only primary source is the legal way to
        // reach a non-table kind (FR-024/ADR-0028 requires an object.entity's primary source
        // to be writable; a derived read model is an object.projection).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "Report", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_report" } },
            { "field.int": { "name": "id" } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        Assert.Contains("public const string SourcePrimaryKind = \"view\";", src);
        // Under the VIEW alias, not a generic `Name` — the member says what the physical
        // name IS. One key called `Name` used to hold a table, a view and a stored procedure
        // in the same run, told apart only by a sibling `Kind`.
        Assert.Contains("public const string SourcePrimaryView = \"v_report\";", src);
        Assert.DoesNotContain("SourcePrimaryTable", src);
        // `Name` is now the OBJECT's name, which is the change a hand-written consumer
        // adopts silently: it still compiles and binds something else.
        Assert.Contains("public const string Name = \"Report\";", src);
        // Read-only-ness is derived from Kind, and no longer carried.
        Assert.DoesNotContain("ReadOnly", src);
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
    public void Two_identities_colliding_on_their_member_form_is_refused_naming_BOTH_nodes()
    {
        // An identity/index name is AUTHOR-CHOSEN and snake_case by convention, so it takes a
        // real segment-splitting Pascal conversion (`uq_cust_email` -> `UqCustEmail`) rather
        // than CSharpNaming.Pascal, which only upper-cases the first character. That
        // conversion is many-to-one: `uq_cust_email` and `uqCustEmail` are two distinct, legal
        // metamodel names that yield ONE constant. Refused here, naming both NODE PATHS, so
        // the message points at the model rather than at a generated file.
        //
        // Fields have had this guard since the artifact existed; identities and indexes
        // acquired the exposure in 0.25.0 when they acquired members, and the guard was
        // widened to the artifact's whole emitted set in the same change — never
        // per-collection, because C# consts share ONE flat namespace per class and because
        // the set has to span the inheritance boundary (a derived `const` HIDES the base's
        // rather than clashing, so the compiler would not catch it either).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Cust", "children": [
            { "source.rdb": { "@table": "custs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "email" } },
            { "field.string": { "name": "alt" } },
            { "identity.primary":   { "name": "pk", "@fields": ["id"] } },
            { "identity.secondary": { "name": "uq_cust_email", "@fields": ["email"] } },
            { "identity.secondary": { "name": "uqCustEmail",   "@fields": ["alt"] } }
          ]}}
        ]}}
        """;
        // The loader is fine with it — the two names are distinct. If it were not, this test
        // would be asserting the loader's rule rather than the artifact's.
        var root = Load(model);
        var ex = Assert.Throws<InvalidOperationException>(
            () => new NamesGenerator().Generate(Ctx(root)).ToList());
        Assert.Contains("Cust", ex.Message);
        Assert.Contains("identity.secondary \"uq_cust_email\"", ex.Message);
        Assert.Contains("identity.secondary \"uqCustEmail\"", ex.Message);
        Assert.Contains("UqCustEmail", ex.Message);
    }

    [Fact]
    public void An_identity_and_an_index_sharing_a_name_do_NOT_collide_because_of_the_TYPE_prefix()
    {
        // The counterpart, and the reason the type prefix is in the member form at all. An
        // `identity.secondary` and an `index.lookup` may legally carry names that Pascalize
        // identically; `Identity`/`Index` keeps them apart, so a model with nothing wrong in
        // it is not refused by a guard meant for a different problem.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Cust", "children": [
            { "source.rdb": { "@table": "custs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "email" } },
            { "identity.primary":   { "name": "pk", "@fields": ["id"] } },
            { "identity.secondary": { "name": "uq_cust_email", "@fields": ["email"] } },
            { "index.lookup":       { "name": "uqCustEmail",   "@fields": ["email"] } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        Assert.Contains("public const string IdentityUqCustEmailIndex = \"uq_cust_email\";", src);
        Assert.Contains("public const string IndexUqCustEmailIndex = \"uqCustEmail\";", src);
    }

    [Fact]
    public void An_author_supplied_value_containing_a_quote_or_backslash_is_escaped()
    {
        // Every VALUE here is author-controlled — object name, key name, @schema, @column.
        // They were spliced straight into a C# string literal. A quote emitted a file that
        // does not compile; a backslash compiled to a silently DIFFERENT value, so
        // `zz\tcol` bound a column name containing a TAB. @column is a quoted SQL
        // identifier and may legally hold either.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Cust", "children": [
            { "source.rdb": { "@table": "custs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "quoted", "@column": "zz\"quote" } },
            { "field.string": { "name": "slashed", "@column": "zz\\tcol" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        // Escaped, so the emitted literal reproduces the authored value exactly.
        Assert.Contains(@"public const string QuotedColumn = ""zz\""quote"";", src);
        Assert.Contains(@"public const string SlashedColumn = ""zz\\tcol"";", src);
        // ...and never the raw form, which would end the literal / re-interpret the escape.
        Assert.DoesNotContain(@"= ""zz""quote""", src);
    }

    [Fact]
    public void A_key_name_starting_with_a_digit_does_not_weld_an_underscore_into_the_middle()
    {
        // PascalToken returns a SEGMENT and every caller concatenates it after a type
        // prefix, so the identifier never starts with it. It nonetheless guarded a leading
        // digit with an `_`, protecting a first character it does not produce and putting
        // a stray underscore mid-identifier: `2fa-idx` came out `Index_2faIdxIndex`. An
        // index name is author-chosen and may legally start with a digit; a digit
        // mid-identifier is legal C#.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Cust", "children": [
            { "source.rdb": { "@table": "custs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "email" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "index.lookup":     { "name": "2fa-idx", "@fields": ["email"] } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new NamesGenerator().Generate(Ctx(Load(model)))).Content;
        Assert.Contains("public const string Index2faIdxIndex = \"2fa-idx\";", src);
        Assert.DoesNotContain("Index_2faIdx", src);
    }

    [Fact]
    public void The_type_prefix_keeps_an_unnamed_primary_key_off_the_primary_ROLE_members()
    {
        // Load-bearing, not decoration. `identity.primary`'s loader defaultName is "primary"
        // (spec/metamodel/identity.json), and a source's default @role is "primary" too — so
        // an unnamed primary key and the primary source share a key. The TYPE prefix is what
        // separates them; without it BOTH would want `PrimaryType`/`PrimarySubType`, and the
        // collision guard above would (correctly) refuse a model with nothing wrong in it.
        var src = SubscriberSource();
        Assert.Contains("public const string SourcePrimaryType = \"source\";", src);
        Assert.Contains("public const string IdentityPrimaryType = \"identity\";", src);
        Assert.Contains("public const string IdentityPrimaryName = \"primary\";", src);
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

    // The REACHABLE divergence, BOTH directions. ValidateOnePrimarySource enforces
    // "exactly one primary" over OWN children only (MetaObjects/Loader/ValidationPasses.cs),
    // and effective-children shadowing (MetaData.EffectiveChildren) matches an own child
    // over a super child only on a (type, name) match — so two source.rdb children with
    // DIFFERENT explicit names never collide, and a parent's and a child's own primary
    // sources both survive on the child's effective Sources(). Each model is asserted to
    // load with ZERO errors before anything else: a guard test whose fixture the loader
    // would reject proves nothing.
    //
    // Direction 1 is the one the old check could see: the inherited primary is read-only,
    // so DbTable (primary AND writable) skipped it and matched the child's. Direction 2 is
    // the one it could not: both primaries are WRITABLE, so DbTable matched the same
    // inherited node the loose scan did, the two agreed, and the guard stayed silent while
    // every generated artifact bound the parent's table over the child's own declaration.
    //
    // Neither model uses object.base — which the JVM cannot instantiate at all — so the
    // same two shapes are expressible in every port.

    private const string DivergentReadOnlyInherited = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "children": [
        { "source.rdb": { "name": "s", "@table": "bases" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}},
      { "object.projection": { "name": "ParentWeird", "abstract": true, "children": [
        { "source.rdb": { "name": "viewSrc", "@kind": "view", "@view": "v_parent" } },
        { "field.long": { "name": "id", "extends": "Base.id" } }
      ]}},
      { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
        { "source.rdb": { "name": "tableSrc", "@table": "child_table" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """;

    private const string DivergentBothWritable = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "ParentWeird", "abstract": true, "children": [
        { "source.rdb": { "name": "parentSrc", "@table": "parent_table" } },
        { "field.long": { "name": "id" } }
      ]}},
      { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
        { "source.rdb": { "name": "childSrc", "@table": "child_table" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """;

    [Theory]
    [InlineData(nameof(DivergentReadOnlyInherited), "v_parent")]
    [InlineData(nameof(DivergentBothWritable), "parent_table")]
    public void A_divergent_primary_source_pair_is_refused_naming_both(string which, string otherName)
    {
        var model = which == nameof(DivergentReadOnlyInherited)
            ? DivergentReadOnlyInherited
            : DivergentBothWritable;
        var root = Load(model);
        var child = root.Objects().Single(o => o.Name == "ChildWeird");

        // Pin the reachability MECHANISM: both sources survive the child merge. If one
        // shadowed the other there would be no divergence and this would pass vacuously.
        var primaries = child.Sources()
            .Where(s => s.Role == "primary")
            .Select(s => s.PhysicalName)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(new[] { otherName, "child_table" }.OrderBy(n => n, StringComparer.Ordinal), primaries);

        var ex = Assert.Throws<InvalidOperationException>(
            () => new NamesGenerator().Generate(Ctx(root)).ToList());
        // All three substrings asserted separately, so a message that drops one still fails.
        Assert.Contains("ChildWeird", ex.Message);
        Assert.Contains(otherName, ex.Message);
        Assert.Contains("child_table", ex.Message);
    }

    [Fact]
    public void Two_primaries_AGREEING_on_a_physical_name_are_not_refused()
    {
        // The guard is about DISAGREEMENT, not about the count. Refusing two primaries
        // that name the same relation would make it stricter than the invariant it
        // protects: an object has ONE physical name, not one source declaration.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "ParentSame", "abstract": true, "children": [
            { "source.rdb": { "name": "parentSrc", "@table": "same_table" } },
            { "field.long": { "name": "id" } }
          ]}},
          { "object.entity": { "name": "ChildSame", "extends": "ParentSame", "children": [
            { "source.rdb": { "name": "childSrc", "@table": "same_table" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """;
        var root = Load(model);
        var child = root.Objects().Single(o => o.Name == "ChildSame");
        var names = CSharpNaming.ResolveObjectNames(child)!;
        // `Name` is the OBJECT's name since 0.25.0; the physical one lives under the role.
        Assert.Equal("ChildSame", names.Name);
        Assert.Equal("same_table", names.Sources["primary"].PhysicalName);
        Assert.Equal("table", names.Sources["primary"].PhysicalNameAlias);

        // The role-keyed shape gives this its OWN way to be too strict, and this is the arm
        // that catches it: keying by @role means two primaries land on ONE key, so a naive
        // "already present ⇒ refuse" would convict a shape the toolchain sanctions. The
        // artifact compares the resolved SourceNames instead — the same DISAGREEMENT rule
        // SourceResolution already enforces, not a stricter one invented here.
        var src = new NamesGenerator().Generate(Ctx(root))
            .Single(f => f.Path == "ChildSameNames.g.cs").Content;
        Assert.Contains("public new const string SourcePrimaryTable = \"same_table\";", src);
    }

    // -------------------------------------------------------------------------
    // Task 4 (program A) — the EF bindings CONSUME the constants above instead
    // of respelling the physical name (spec §A6).
    // -------------------------------------------------------------------------

    [Fact]
    public void Entity_Table_and_Column_attributes_reference_the_name_constants()
    {
        var ctx = Ctx(Load(SubscriberModel));
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "Subscriber.g.cs").Content;

        Assert.Contains("[Table(SubscriberNames.SourcePrimaryTable)]", src);
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", src);
        Assert.Contains("[Column(SubscriberNames.CallPurposeColumn)]", src);
        Assert.Contains("[Column(SubscriberNames.IdColumn)]", src);
        // The literals this replaces must be GONE, not merely joined by the constant.
        Assert.DoesNotContain("[Table(\"subscribers\")]", src);
        Assert.DoesNotContain("[Column(\"created_at\")]", src);
        Assert.DoesNotContain("[Column(\"purpose_code\")]", src);
        Assert.DoesNotContain("[Column(\"id\")]", src);
    }

    [Fact]
    public void TPH_subtype_columns_reference_the_subtypes_own_name_constants_not_a_miss()
    {
        // The subtype's own field (quantity) IS present in ITS OWN <Sub>Names artifact —
        // ResolveObjectNames(subtype).Fields is built from subtype.Fields(), the exact
        // same resolving Fields() call EmitTphSubtypeClass iterates (ADR-0039). This is
        // NOT the lookup-miss case; a miss needs an owner with no primary source at all
        // (see the flattened-value-object test below), which a TPH subtype never is —
        // it always inherits the discriminator base's primary source.
        const string model = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "auths" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Bridge"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
          ]}}
        ]}}
        """;
        var ctx = Ctx(Load(model), ColumnNamingStrategy.Literal);
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "BridgeAuth.g.cs").Content;

        Assert.Contains("[Column(BridgeAuthNames.QuantityColumn)]", src);
        Assert.DoesNotContain("[Column(\"quantity\")]", src);
        // The subtype class itself carries no [Table] (TPH subtypes share the base's table).
        Assert.DoesNotContain("[Table(", src);
    }

    [Fact]
    public void DbContext_ToView_and_ToJson_reference_the_name_constants()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Config", "children": [
            { "field.string": { "name": "flag" } }
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "config", "@objectRef": "Config" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.projection": { "name": "CustomerSummary", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
            { "field.string": { "name": "tag" } }
          ]}}
        ]}}
        """;
        var ctx = Ctx(Load(model), ColumnNamingStrategy.Literal);
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // Projection .ToView — the unconditional [Table]-shaped substitution (keyless:
        // CustomerSummary declares no identity, so .HasNoKey() precedes it).
        Assert.Contains("modelBuilder.Entity<CustomerSummary>().HasNoKey().ToView(CustomerSummaryNames.SourcePrimaryView);", dbContext);
        Assert.DoesNotContain("ToView(\"v_customer_summary\")", dbContext);

        // Object-typed field .ToJson — the owner's own field, always present.
        Assert.Contains("b.ToJson(CustomerNames.ConfigColumn)", dbContext);
        Assert.DoesNotContain("b.ToJson(\"config\")", dbContext);
    }

    [Fact]
    public void Flattened_value_object_nested_columns_keep_the_literal_a_genuine_lookup_miss()
    {
        // Address (object.value) has NO primary source (FR-024 value purity forbids
        // one) and therefore NO <Address>Names artifact at all — CSharpNaming.ColumnRef
        // misses unconditionally here, and the value it would need ("homeAddress_street",
        // a PREFIXED composite) isn't even a bare physical name a names constant holds.
        // This is the "a lookup miss is normal and keeps the literal" case, distinct from
        // the divergence case below — ResolveObjectNames(Address) is never called (there
        // is no primary source to resolve), so there is nothing to disagree with.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "street" } }
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var ctx = Ctx(Load(model), ColumnNamingStrategy.Literal);
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        Assert.Contains("HasColumnName(\"homeAddress_street\");", dbContext);
        Assert.DoesNotContain("AddressNames", dbContext);
    }

    [Fact]
    public void The_entity_generator_ALSO_refuses_the_divergent_shape_with_names_OFF()
    {
        // This test used to assert the opposite, and its premise has been retired twice
        // over. It asserted that only NamesGenerator could refuse a divergent object,
        // because the shape was only expressible on an `object.base` — which satisfies
        // neither IsEntity() nor DbView, so the entity and db-context generators filtered
        // it out before ever resolving a name.
        //
        // Both halves of that are gone. `object.base` is an abstract registry anchor and
        // may no longer be authored at all, and the divergence is expressible on two plain
        // entities — which the entity generator DOES reach, and whose [Table] line names
        // one of the two disagreeing relations.
        //
        // Ctx() leaves IncludeNames FALSE, which is the point: that is the arm a run takes
        // when `names` is not in the selection, so ResolveObjectNames is never called and
        // CSharpNaming.Table answers alone. Before the guard moved onto Table as well, this
        // arm emitted [Table("parent_table")] for ChildWeird — binding the PARENT's table
        // while the child declared its own — silently, on exactly the arm where nothing
        // else looks. A refusal that depends on which generators ran is not a refusal.
        //
        // DbContextGenerator is deliberately NOT asserted here: it resolves a physical name
        // only for a projection's .ToView(...), and takes an entity's table from the POCO's
        // own [Table] attribute. It never names this object, so it cannot refuse it, and a
        // test claiming otherwise would be asserting a guarantee the code does not make.
        var root = Load(DivergentBothWritable);

        var entityEx = Assert.Throws<InvalidOperationException>(
            () => new EntityGenerator().Generate(Ctx(root)).ToList());
        Assert.Contains("ChildWeird", entityEx.Message);
        Assert.Contains("parent_table", entityEx.Message);
        Assert.Contains("child_table", entityEx.Message);
    }

    [Fact]
    public void The_RUNTIME_physical_name_accessor_ALSO_refuses_the_divergent_shape()
    {
        // The door no generator opens. MetaObjects.Codegen/Runtime/M2MResolver.TableOf is
        // `obj.DbTable ?? obj.DbView`, and it executes SQL against the answer — it runs at
        // request time, with no generator anywhere in the process. While the refusal lived
        // in CSharpNaming it therefore never ran for that caller, and a divergent object
        // silently resolved "parent_table" for an entity that declares "child_table":
        // wrong rows, no error.
        //
        // The refusal now lives in MetaObjects.Meta.SourceResolution and is called from
        // MetaObject.FindPrimaryWritableSource, which DbTable resolves through — so this
        // asserts the exact expression TableOf evaluates. CSharpNaming.Table inherits it
        // through the same accessor rather than carrying a second copy of the check.
        var root = Load(DivergentBothWritable);
        var child = root.Objects().Single(o => o.Name == "ChildWeird");

        var ex = Assert.Throws<InvalidOperationException>(() => _ = child.DbTable);
        // All three substrings asserted separately, so a message that drops one still fails.
        Assert.Contains("ChildWeird", ex.Message);
        Assert.Contains("parent_table", ex.Message);
        Assert.Contains("child_table", ex.Message);

        // SourceResolution's own two entry points, on the same fixture.
        Assert.Throws<InvalidOperationException>(() => SourceResolution.PrimaryRdbSource(child));
        Assert.Throws<InvalidOperationException>(() => SourceResolution.RefuseDivergentPrimaries(child));
    }

    [Fact]
    public void The_default_generator_suite_fails_the_run_on_a_divergent_primary_source()
    {
        // R-E's corrected version of the brief's sketched
        // Assert.Throws<GeneratorException>(() => GenerateEntity("WeirdBase")): no such
        // type as GeneratorException exists anywhere in this port, and no per-generator
        // call reaches the divergent shape (see the test above). D4's guarantee — every
        // consumption site references the constant unconditionally, divergence is a
        // build error — is delivered at the RUN level: "names" is a member of
        // GenCommand.DefaultGeneratorNames, so a default `dotnet meta gen` over this
        // model fails via NamesGenerator's own InvalidOperationException, caught and
        // surfaced by GenCommand.Run as a clean Outcome failure naming both sides.
        var load = new MetaDataLoader().Load(
            [new InMemoryStringSource(DivergentBothWritable, id: "gen.json")]);
        Assert.Empty(load.Errors);

        var tmp = Path.Combine(Path.GetTempPath(), "moc-names-run-" + Guid.NewGuid().ToString("N"));
        var outcome = GenCommand.Run(
            load, outDir: Path.Combine(tmp, "out"), ns: "Acme.Generated", emitAbstractShapes: false,
            generatorNames: null, templateRoot: null, templateSpecPath: null, projectRoot: tmp);

        Assert.False(outcome.Ok);
        var message = string.Join("\n", outcome.LoadErrors);
        Assert.Contains("ChildWeird", message);
        Assert.Contains("parent_table", message);
        Assert.Contains("child_table", message);
    }

    // -------------------------------------------------------------------------
    // C1 (Critical) -- the RUN-LEVEL presence gate (GenConfig.IncludeNames). Every
    // test above proves the ON arm: names IS part of the run, and every consumption
    // site above resolves the constant. Before this gate existed, EntityGenerator and
    // DbContextGenerator referenced <Entity>Names UNCONDITIONALLY -- with no notion of
    // "is the names generator even in this run" -- so `dotnet meta gen --generators
    // entity,db-context` (a documented, individually-selectable subset;
    // GenCommand.DefaultGeneratorNames's own doc comment says every default name is
    // selectable individually) emitted a dangling reference to a class NO generator in
    // that run produces: 4x CS0103 against a real EF Core compile, reproduced
    // independently twice.
    //
    // These tests prove the OFF arm: with `names` absent from the run, the EF bindings
    // fall back to EXACTLY the literal spelling this codegen emitted before Program A
    // added the constant (git 488143e21) -- byte for byte, not a substring both arms
    // would satisfy. Every assertion below is paired: the literal IS present, and the
    // constant-reference spelling it replaces is GONE.
    // -------------------------------------------------------------------------

    private static GenContext CtxWithoutNames(MetaRoot root, ColumnNamingStrategy strategy = ColumnNamingStrategy.SnakeCase) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = strategy,
            // The fact under test: this GenContext models a run where `names` was never
            // selected (e.g. `--generators entity,db-context`). GenConfig.IncludeNames
            // now defaults to false too, but this sets it explicitly rather than relying
            // on that default -- this class's Ctx() helper above is the ON arm, and this
            // is the OFF arm; the point is which arm each test exercises, not the default.
            IncludeNames = false,
        },
    };

    // A prior version of this file had a
    // "C1_with_names_absent_from_the_run_NamesGenerator_itself_emits_nothing_here" test
    // here that ran only EntityGenerator + DbContextGenerator and asserted no emitted
    // path contained "Names". Neither generator can EVER emit a "Names"-titled path
    // under any GenConfig -- only NamesGenerator does, and this test never invoked it --
    // so the assertion passed identically on both the ON and OFF arm and proved nothing
    // about GenConfig.IncludeNames. The real end-to-end version of this claim (that a
    // narrowed `--generators entity,db-context` selection produces no SubscriberNames.g.cs
    // on disk) is
    // C1_The_OFF_arm_reaches_the_CLI_a_narrowed_generators_selection_never_sets_IncludeNames
    // below, which asserts File.Exists(...) is false -- an assertion that fails if the
    // behavior regresses. Deleted rather than kept as a vacuous duplicate.

    [Fact]
    public void C1_with_names_absent_Entity_Table_and_Column_fall_back_to_the_pre_ProgramA_literal()
    {
        var ctx = CtxWithoutNames(Load(SubscriberModel));
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "Subscriber.g.cs").Content;

        // The exact literal spellings EntityGenerator emitted before Program A referenced
        // the constant (git 488143e21) -- present.
        Assert.Contains("[Table(\"subscribers\")]", src);
        Assert.Contains("[Column(\"created_at\")]", src);
        Assert.Contains("[Column(\"purpose_code\")]", src);
        Assert.Contains("[Column(\"id\")]", src);

        // The constant-reference spelling this replaces -- GONE, not merely joined by
        // the literal. A generator emitting both would satisfy every Contains above.
        Assert.DoesNotContain("SubscriberNames", src);
        Assert.DoesNotContain("[Table(SubscriberNames.SourcePrimaryTable)]", src);
        Assert.DoesNotContain("[Column(SubscriberNames.CreatedAtColumn)]", src);
        Assert.DoesNotContain("[Column(SubscriberNames.CallPurposeColumn)]", src);
        Assert.DoesNotContain("[Column(SubscriberNames.IdColumn)]", src);
    }

    [Fact]
    public void C1_with_names_absent_TPH_subtype_columns_fall_back_to_the_pre_ProgramA_literal()
    {
        const string model = """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":       { "@table": "auths" } },
            { "field.long":       { "name": "id" } },
            { "field.enum":       { "name": "type", "@values": ["Bridge"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
          ]}}
        ]}}
        """;
        var ctx = CtxWithoutNames(Load(model), ColumnNamingStrategy.Literal);
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "BridgeAuth.g.cs").Content;

        Assert.Contains("[Column(\"quantity\")]", src);
        Assert.DoesNotContain("BridgeAuthNames", src);
        Assert.DoesNotContain("[Column(BridgeAuthNames.QuantityColumn)]", src);
    }

    [Fact]
    public void C1_with_names_absent_DbContext_ToView_and_ToJson_fall_back_to_the_pre_ProgramA_literal()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Config", "children": [
            { "field.string": { "name": "flag" } }
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "config", "@objectRef": "Config" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.projection": { "name": "CustomerSummary", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
            { "field.string": { "name": "tag" } }
          ]}}
        ]}}
        """;
        var ctx = CtxWithoutNames(Load(model), ColumnNamingStrategy.Literal);
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // Exactly what these two lines emitted before Program A added the constant.
        Assert.Contains("modelBuilder.Entity<CustomerSummary>().HasNoKey().ToView(\"v_customer_summary\");", dbContext);
        Assert.Contains("b.ToJson(\"config\")", dbContext);

        Assert.DoesNotContain("CustomerSummaryNames", dbContext);
        Assert.DoesNotContain("CustomerNames", dbContext);
        Assert.DoesNotContain("ToView(CustomerSummaryNames.SourcePrimaryView)", dbContext);
        Assert.DoesNotContain("b.ToJson(CustomerNames.ConfigColumn)", dbContext);
    }

    [Fact]
    public void C1_The_OFF_arm_reaches_the_CLI_a_narrowed_generators_selection_never_sets_IncludeNames()
    {
        // The end-to-end reproduction: `dotnet meta gen --generators entity,db-context`
        // over an ordinary sourced entity. Before the fix, GenCommand.Run built GenConfig
        // with no notion of which generators were selected, so EntityGenerator always
        // referenced the constant -- this run would have written a Subscriber.g.cs
        // naming a class no file in this run's output declares.
        var load = new MetaDataLoader().Load([new InMemoryStringSource(SubscriberModel, id: "gen.json")]);
        Assert.Empty(load.Errors);

        var tmp = Path.Combine(Path.GetTempPath(), "moc-names-c1-" + Guid.NewGuid().ToString("N"));
        var outcome = GenCommand.Run(
            load, outDir: Path.Combine(tmp, "out"), ns: "Acme.Generated", emitAbstractShapes: false,
            generatorNames: ["entity", "db-context"], templateRoot: null, templateSpecPath: null, projectRoot: tmp);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        var outDir = Path.Combine(tmp, "out");
        Assert.False(File.Exists(Path.Combine(outDir, "SubscriberNames.g.cs")));

        var entitySrc = File.ReadAllText(Path.Combine(outDir, "Subscriber.g.cs"));
        Assert.Contains("[Table(\"subscribers\")]", entitySrc);
        Assert.DoesNotContain("SubscriberNames", entitySrc);
    }

    [Fact]
    public void GenConfig_IncludeNames_defaults_to_false_so_a_bare_config_falls_back_to_the_literal()
    {
        // Pins GenConfig.IncludeNames's DEFAULT itself, distinct from every test above
        // (which all set the flag one way or the other explicitly). A GenConfig built
        // with no opinion about IncludeNames models a caller who says nothing about
        // which generators it plans to run -- a programmatic embedder, or a hand-built
        // test fixture -- and must fail in the SAFE direction: the literal, not a
        // dangling reference to a class that may not exist in that caller's output.
        // Mirrors codegen-ts's render-context.ts `includeNames: opts.includeNames ?? false`
        // -- the two reference ports must not disagree on this default.
        var root = Load(SubscriberModel);
        var ctx = new GenContext
        {
            Entities = root.Objects(), Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" }, // IncludeNames unset
        };
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "Subscriber.g.cs").Content;

        // Positive: the literal spelling is present.
        Assert.Contains("[Table(\"subscribers\")]", src);
        // Negative, paired so this cannot pass vacuously: no reference to the names
        // artifact's symbol appears anywhere in the emitted entity.
        Assert.DoesNotContain("SubscriberNames", src);
    }
}
