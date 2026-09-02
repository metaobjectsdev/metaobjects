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


    // -------------------------------------------------------------------------
    // Task 4 (program A) — the EF bindings CONSUME the constants above instead
    // of respelling the physical name (spec §A6).
    // -------------------------------------------------------------------------

    [Fact]
    public void Entity_Table_and_Column_attributes_reference_the_name_constants()
    {
        var ctx = Ctx(Load(SubscriberModel));
        var src = new EntityGenerator().Generate(ctx).Single(f => f.Path == "Subscriber.g.cs").Content;

        Assert.Contains("[Table(SubscriberNames.Name)]", src);
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
        Assert.Contains("modelBuilder.Entity<CustomerSummary>().HasNoKey().ToView(CustomerSummaryNames.Name);", dbContext);
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
    public void R_E_EntityGenerator_and_DbContextGenerator_never_reach_the_divergent_object_base_shape()
    {
        // R-E: the divergence below (object.base carrying a read-only primary source
        // inherited beside a child's own writable primary) can be REFUSED only by
        // NamesGenerator (via CSharpNaming.ResolveObjectNames) — never observed by
        // EntityGenerator or DbContextGenerator directly. Both filter their working set
        // to IsEntity() || DbView is not null; object.base satisfies neither
        // (FR-024/ADR-0028's ERR_ENTITY_PRIMARY_SOURCE_READONLY bans a read-only
        // primary on object.entity outright, and DbView is OWN-only, so ChildWeird's
        // own writable table source never registers as a DbView). Reusing the exact
        // model from A_divergent_primary_and_writable_source_pair_is_refused_naming_both
        // above — establishes the brief's Step 1 sketch
        // (Assert.Throws<GeneratorException>(() => GenerateEntity("WeirdBase"))) cannot
        // pass: neither generator ever resolves names for ChildWeird, so neither can
        // throw on its behalf. The RUN-level guarantee is proven separately below.
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

        var entityFiles = new EntityGenerator().Generate(Ctx(root)).ToList();
        Assert.DoesNotContain(entityFiles, f => f.Path.Contains("Weird"));

        // Neither ParentWeird nor ChildWeird is IsEntity() or DbView-bearing, so the
        // DbSet/OnModelCreating loops never touch them either — DbContextGenerator
        // emits no AppDbContext file at all for a model with nothing to map.
        var dbContextFiles = new DbContextGenerator().Generate(Ctx(root)).ToList();
        Assert.All(dbContextFiles, f => Assert.DoesNotContain("Weird", f.Content));
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
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "gen.json")]);
        Assert.Empty(load.Errors);

        var tmp = Path.Combine(Path.GetTempPath(), "moc-names-run-" + Guid.NewGuid().ToString("N"));
        var outcome = GenCommand.Run(
            load, outDir: Path.Combine(tmp, "out"), ns: "Acme.Generated", emitAbstractShapes: false,
            generatorNames: null, templateRoot: null, templateSpecPath: null, projectRoot: tmp);

        Assert.False(outcome.Ok);
        var message = string.Join("\n", outcome.LoadErrors);
        Assert.Contains("ChildWeird", message);
        Assert.Contains("v_parent", message);
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

    [Fact]
    public void C1_with_names_absent_from_the_run_NamesGenerator_itself_emits_nothing_here()
    {
        // Establishes the premise the tests below depend on: in a run wired this way
        // (NamesGenerator simply never included), no <Entity>Names.g.cs exists at all --
        // this is a fact about which generators RAN, not a change to NamesGenerator
        // itself (its own Filter/Generate never read GenConfig.IncludeNames).
        var files = new List<EmittedFile>();
        foreach (var gen in new IGenerator[] { new EntityGenerator(), new DbContextGenerator() })
            files.AddRange(gen.Generate(CtxWithoutNames(Load(SubscriberModel))));
        Assert.DoesNotContain(files, f => f.Path.Contains("Names", StringComparison.Ordinal));
    }

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
        Assert.DoesNotContain("[Table(SubscriberNames.Name)]", src);
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
        Assert.DoesNotContain("ToView(CustomerSummaryNames.Name)", dbContext);
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
