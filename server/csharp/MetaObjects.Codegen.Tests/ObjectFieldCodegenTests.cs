using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// Object-typed entity fields -> EF Core owned types. @storage flattened maps each
// nested scalar to "{parentCol}_{nestedCol}"; absent/jsonb collapses to one json
// column via .ToJson. The nested value object is emitted as a plain POCO.
public class ObjectFieldCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city", "@maxLength": 80 } },
        { "field.enum":   { "name": "kind",  "@values": ["HOME", "WORK"] } },
        { "field.enum":   { "name": "grade", "@values": ["LO", "HI"], "@intValueMap": { "LO": 1, "HI": 2 } } }
      ]}},
      { "object.value": { "name": "Badge", "children": [
        { "field.string": { "name": "code" } },
        { "field.enum":   { "name": "tier", "@values": ["GOLD", "SILVER"] } }
      ]}},
      { "object.value": { "name": "Profile", "children": [
        { "field.string": { "name": "handle" } },
        { "field.enum":   { "name": "roles", "@values": ["ADMIN", "USER"], "isArray": true } },
        { "field.object": { "name": "badge", "@objectRef": "Badge" } },
        { "field.map":    { "name": "prefs", "@objectRef": "Badge" } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config", "@objectRef": "Address" } },
        { "field.object": { "name": "tags", "@objectRef": "Address", "@storage": "jsonb", "isArray": true } },
        { "field.object": { "name": "profile", "@objectRef": "Profile", "@storage": "flattened" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "obj.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        // IncludeNames: true -- the b.ToJson(CustomerNames....Column) assertions below
        // need the db-context generator to reference the names artifact;
        // GenConfig.IncludeNames defaults to false.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
    };

    [Fact]
    public void Entity_gets_owned_type_navigation_properties()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        Assert.Contains("public string Name { get; set; } = default!;", customer);
        // Object fields -> nullable owned-type navigations (no [Column] on the nav).
        Assert.Contains("public Address? HomeAddress { get; set; }", customer);
        Assert.Contains("public Address? Config { get; set; }", customer);
        Assert.DoesNotContain("[Column(\"homeAddress\")]", customer);
    }

    [Fact]
    public void Referenced_value_object_is_emitted_as_a_plain_poco()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var address = files.Single(f => f.Path == "Address.g.cs").Content;

        Assert.Contains("public class Address", address);
        Assert.Contains("public string Street { get; set; } = default!;", address); // required
        Assert.Contains("public string? City { get; set; }", address);              // optional
        // POCO carries no mapping attributes — columns come from fluent owned config.
        Assert.DoesNotContain("[Table(", address);
        Assert.DoesNotContain("[Column(", address);
        Assert.DoesNotContain("[Key]", address);
    }

    [Fact]
    public void DbContext_configures_owned_types_flattened_and_json()
    {
        var ctx = Ctx(Load());
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // Flattened: per-property column names prefixed by the parent column. §A6 —
        // NOT converted: Address (object.value) has no primary source and so no
        // AddressNames artifact, and the prefixed name is a composite no single
        // constant could hold anyway (a genuine lookup miss).
        Assert.Contains("modelBuilder.Entity<Customer>().OwnsOne(x => x.HomeAddress, b =>", dbContext);
        Assert.Contains("b.Property(p => p.Street).HasColumnName(\"homeAddress_street\");", dbContext);
        Assert.Contains("b.Property(p => p.City).HasColumnName(\"homeAddress_city\");", dbContext);
        // The value object's ENUM members are flattened the same way — migrate-ts's
        // flattenObjectField prefixes EVERY nested member, and TS owns the schema — and carry
        // the same conversion an entity-level enum gets: string-backed → the member symbol in a
        // text column; @intValueMap → the declared integers. Before this, an enum member fell
        // through to EF's own defaults (`HomeAddress_Kind`, integer) and bound a column the
        // migration never created — measured against a real Postgres, not inferred.
        Assert.Contains("b.Property(p => p.Kind).HasColumnName(\"homeAddress_kind\").HasConversion<string>();", dbContext);
        Assert.Contains(
            "b.Property(p => p.Grade).HasColumnName(\"homeAddress_grade\").HasConversion(v => v == Address.AddressGrade.LO ? 1 : 2, " +
            "v => v == 1 ? Address.AddressGrade.LO : v == 2 ? Address.AddressGrade.HI : UnmappedEnumValue<Address.AddressGrade>(v, \"grade\"));",
            dbContext);
        // ...and the fail-fast helper that converter names is declared, even though the ONLY
        // int-backed enum in this model lives on the value object, which is not an emitted
        // DbSet and so is invisible to a scan of the mapped objects' own fields.
        Assert.Contains("private static T UnmappedEnumValue<T>(int stored, string field)", dbContext);
        // Default (no @storage): single json column. §A6 (task 4) — converted: the
        // field belongs to Customer itself, which always has a names artifact.
        //
        // The VO's enum members carry an explicit string conversion INSIDE the JSON document.
        // EF Core 8's default for an unconfigured enum is its int ORDINAL, so without these
        // lines `kind` stored as `{"kind": 0}` where TS, Java, Kotlin and Python all store the
        // member SYMBOL — a silent cross-port wire break. Note `grade` converts to a STRING here
        // despite carrying @intValueMap: the int map is a COLUMN-storage concern and there is no
        // column inside a JSON document (the flattened arm above is where its int pair belongs).
        Assert.Contains(
            """
                    modelBuilder.Entity<Customer>().OwnsOne(x => x.Config, b =>
                    {
                        b.ToJson(CustomerNames.ConfigColumn);
                        b.Property(p => p.Kind).HasConversion<string>();
                        b.Property(p => p.Grade).HasConversion<string>();
                    });
            """,
            dbContext);
    }

    // Program D — the routes tier's post-save null clear for the nullable @isArray jsonb
    // column (`tags`) is a raw UPDATE whose table / json-column / PK-column IDENTIFIERS
    // cannot be parameters, so they are spliced into the SQL text. With the names artifact
    // in the run they are the <Entity>Names constants, concatenated (still a compile-time
    // constant); without it the single literal string this generator always emitted — the
    // ADR-0034 fallback arm, byte-identical. The no-magic gate proves the ON arm spells no
    // physical name; this pins the exact emitted form of BOTH arms.
    [Fact]
    public void Routes_array_null_clear_composes_its_identifiers_from_the_names_constants()
    {
        var routes = new RoutesGenerator().Generate(Ctx(Load()))
            .Single(f => f.Path == "CustomerRoutes.g.cs").Content;
        // `tags` is the THIRD value-object field (after homeAddress and config), hence __clearVo2.
        Assert.Contains(
            "if (__clearVo2) await db.Database.ExecuteSqlRawAsync(\"UPDATE \\\"\" + CustomerNames.Name + " +
            "\"\\\" SET \\\"\" + CustomerNames.TagsColumn + \"\\\" = NULL WHERE \\\"\" + CustomerNames.IdColumn + \"\\\" = {0}\", id);",
            routes);
        // The needle is the ESCAPED form as it appears in the emitted C# source — `\"customers\"`
        // — not `"customers"`. The generated line spells the table inside a C# string literal, so
        // the character after `customers` is a backslash, never a quote: the unescaped needle
        // matched neither the constant-referencing output above NOR the literal output the sibling
        // test pins, and passed identically either way. It was pinning nothing.
        Assert.DoesNotContain("\\\"customers\\\"", routes);
    }

    [Fact]
    public void Routes_array_null_clear_spells_the_literals_when_the_names_artifact_is_not_in_the_run()
    {
        var root = Load();
        var ctx = new GenContext
        {
            Entities = root.Objects(), Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = false },
        };
        var routes = new RoutesGenerator().Generate(ctx).Single(f => f.Path == "CustomerRoutes.g.cs").Content;
        Assert.Contains(
            "if (__clearVo2) await db.Database.ExecuteSqlRawAsync(\"UPDATE \\\"customers\\\" SET \\\"tags\\\" = NULL WHERE \\\"id\\\" = {0}\", id);",
            routes);
        Assert.DoesNotContain("CustomerNames", routes);
    }

    // The flattened member set must equal the set migrate flattens. migrate's
    // flattenObjectField iterates the value object's fields UNCONDITIONALLY and emits one
    // `<prefix>_<member col>` per member, so any member this generator skips silently gets
    // EF's `<Nav>_<Prop>` default — a column no migration creates, failing at the engine
    // with 42703. Scalars and non-array enums were covered; an ARRAY enum and a NESTED
    // value object were not, and are covered here. `field.map` is deliberately still not
    // named and must WARN instead of emitting a wrong column (see the sibling test).
    [Fact]
    public void DbContext_names_every_flattened_member_the_migration_creates()
    {
        var ctx = Ctx(Load());
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // A plain scalar member: the pre-existing rule, pinned here so the ordering of the
        // richer members below is anchored to something already known-correct.
        Assert.Contains("b.Property(p => p.Handle).HasColumnName(\"profile_handle\");", dbContext);

        // An ARRAY enum member. Native array column on the migrate side (text[] derived from
        // isArray), EF Core 8 primitive collection here, with the per-element conversion —
        // else the members persist as int ordinals inside the array.
        Assert.Contains(
            "b.PrimitiveCollection(p => p.Roles).HasColumnName(\"profile_roles\").ElementType().HasConversion<string>();",
            dbContext);

        // A NESTED value object member: ONE json column at `<prefix>_<col>` (migrate's
        // subtypeToSqlType returns json for field.object — a nested VO does not flatten
        // recursively), so it needs its own ToJson pinned to that column. The nested builder
        // is `nb`: emitting `b.` here would not compile in the GENERATED file.
        Assert.Contains(
            """
                        b.OwnsOne(p => p.Badge, nb =>
                        {
                            nb.ToJson("profile_badge");
                            nb.Property(p => p.Tier).HasConversion<string>();
                        });
            """,
            dbContext);
    }

    // The one member kind deliberately NOT named. This port configures a top-level field.map
    // nowhere either, so there is no proven mapping to mirror, and forcing b.Property onto a
    // Dictionary<string,T> can make EF's model builder throw where it currently ignores the
    // member — trading a wrong column for a broken build. The requirement is that it be LOUD:
    // a silent skip here is exactly the defect class this whole test exists for.
    [Fact]
    public void A_flattened_map_member_warns_instead_of_binding_a_wrong_column()
    {
        var warnings = new List<string>();
        var root = Load();
        var ctx = new GenContext
        {
            Entities = root.Objects(), Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
            Warn = warnings.Add,
        };
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        Assert.Contains(warnings, w => w.Contains("\"prefs\"") && w.Contains("profile_prefs"));
        // ...and it must not have quietly emitted a mapping for it either.
        Assert.DoesNotContain("p.Prefs", dbContext);
    }

    [Fact]
    public void DbContext_configures_array_of_value_object_jsonb_as_OwnsMany()
    {
        var ctx = Ctx(Load());
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // An @isArray object field is a COLLECTION of the value object (ICollection<Address>),
        // so EF must map it with .OwnsMany(...).ToJson(...) — .OwnsOne over a collection fails
        // at EF model finalization ("must be a non-interface reference type to be used as an
        // entity type"). Regression gate for the array-of-VO jsonb path.
        // §A6. The VO's enum members take the same string conversion here as on the OwnsOne
        // arm — an array of value objects is still a JSON document, and each element's `kind`
        // must serialize as the member symbol rather than EF's ordinal.
        Assert.Contains(
            """
                    modelBuilder.Entity<Customer>().OwnsMany(x => x.Tags, b =>
                    {
                        b.ToJson(CustomerNames.TagsColumn);
                        b.Property(p => p.Kind).HasConversion<string>();
                        b.Property(p => p.Grade).HasConversion<string>();
                    });
            """,
            dbContext);
        Assert.DoesNotContain("OwnsOne(x => x.Tags", dbContext);
    }

    [Fact]
    public void Generated_entities_and_value_objects_compile_together()
    {
        var ctx = Ctx(Load());
        // §A6 (task 4) — Customer now references CustomerNames.
        //
        // The DbContext is in the compilation DELIBERATELY. Its owned-type configuration is
        // where the flattened/JSON column mapping actually lives, and it was the ONE tier the
        // string assertions above could not vouch for: a nested owned block names its builder
        // `nb`, and emitting the outer `b` there is invalid C# that every text assertion in
        // this file would still have matched. EF's own model builder needs a live provider and
        // is out of reach here, so this proves the config COMPILES, not that EF accepts the
        // model — but a config that does not compile can no longer reach an adopter.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new NamesGenerator().Generate(ctx))
            .Concat(new DbContextGenerator().Generate(ctx)).ToList();
        var trees = files.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("objfieldcompile_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity + value object should compile, got: " + string.Join("; ", errors));
    }
}
