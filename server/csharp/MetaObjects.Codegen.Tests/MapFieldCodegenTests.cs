using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using System.Linq.Expressions;
using System.Reflection;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// field.map — an open-keyed map (Dictionary<string, V>) stored in a single json
// column (the map analog of field.object). The value type is a scalar (@valueType)
// or a value-object (@objectRef). Cross-port parity: the TS field-map.test.ts +
// the Python entity_model map branch.
public class MapFieldCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city", "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "field.map":    { "name": "labels", "@valueType": "string" } },
        { "field.map":    { "name": "addresses", "@objectRef": "Address" } },
        { "field.map":    { "name": "channels", "@valueType": "string", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string model = Model, string id = "map.json")
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: id)]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        // IncludeNames: true -- the [Column(CustomerNames....Column)] assertions below
        // need the entity to reference the names artifact; GenConfig.IncludeNames
        // defaults to false.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
    };

    [Fact]
    public void Scalar_valued_map_emits_a_string_value_dictionary()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        // @valueType:string → Dictionary<string, string>, [Column]-mapped. NULLABILITY
        // FOLLOWS THE COLUMN (ObjectNavProperty's rule): the migration creates a map
        // column NULLABLE by default, and a non-nullable property over it made EF Core 8
        // skip the shaper's IsDBNull check — a 500 on every read of a NULL-map row (the
        // MapNullColumnGeneratedServerTest lane drives that end-to-end). So a
        // non-required map is NULLABLE with NO initializer (absent stays null, round-trips
        // as SQL NULL — never silently rewritten to {}), while a @required map keeps the
        // non-null empty-dictionary initializer.
        Assert.Contains("[Column(CustomerNames.LabelsColumn)]", customer); // §A6 (task 4)
        Assert.Contains("public Dictionary<string, string>? Labels { get; set; }", customer);
        Assert.Contains("public Dictionary<string, string> Channels { get; set; } = new();", customer);
    }

    [Fact]
    public void Object_valued_map_emits_a_value_object_value_dictionary()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        // @objectRef:Address → Dictionary<string, Address> (nullable — see the scalar test
        // for the column-following rule); the VO is emitted as a POCO.
        Assert.Contains("[Column(CustomerNames.AddressesColumn)]", customer); // §A6 (task 4)
        Assert.Contains("public Dictionary<string, Address>? Addresses { get; set; }", customer);
        Assert.Contains("public class Address", files.Single(f => f.Path == "Address.g.cs").Content);
    }

    [Fact]
    public void Scalar_valued_map_gets_a_jsonb_storage_mapping_in_the_DbContext()
    {
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        // WHY an explicit mapping is needed at all is stated once, at the emission site
        // (the map loop in DbContextGenerator.EmitFieldTypeConfig): an unmapped Dictionary
        // does not land on the jsonb column the migration creates.
        Assert.Contains(
            "modelBuilder.Entity<Customer>().Property(x => x.Labels).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<string>(), MapJsonb.Comparer<string>());",
            dbCtx);
        // The @required map's property is non-null, so its converter is the non-null
        // factory — EF Core 8's nullability-aware HasConversion checks the converter's
        // model type against the property's own annotation (a mismatch is CS8620).
        Assert.Contains(
            "modelBuilder.Entity<Customer>().Property(x => x.Channels).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.RequiredConverter<string>(), MapJsonb.Comparer<string>());",
            dbCtx);
    }

    [Fact]
    public void Object_valued_map_gets_a_jsonb_storage_mapping_typed_by_the_value_object()
    {
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        Assert.Contains(
            "modelBuilder.Entity<Customer>().Property(x => x.Addresses).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<Acme.Generated.Address>()"
                + ", MapJsonb.Comparer<Acme.Generated.Address>());",
            dbCtx);
    }

    [Fact]
    public void Map_jsonb_helper_is_emitted_only_when_a_map_is_present()
    {
        var withMap = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        // The shared converter/comparer pair. The COMPARER is the load-bearing half: with a
        // value converter and no comparer EF snapshots the dictionary by reference, so an
        // in-place `entity.Labels["k"] = v` is never detected and the UPDATE never fires --
        // the same silent non-persistence this mapping exists to fix.
        Assert.Contains("private static class MapJsonb", withMap);
        // The nullable type arguments match the nullable map property (EF Core 8's
        // nullability-aware HasConversion expects them; see EmitMapJsonbHelper remarks).
        Assert.Contains("Dictionary<string, TValue>?, string> Converter<TValue>()", withMap);
        Assert.Contains("Dictionary<string, TValue>?> Comparer<TValue>()", withMap);

        // Equality must be ENTRY-WISE, not a comparison of serialized JSON. JSON string
        // equality is key-ORDER sensitive, so a dictionary rebuilt in a different order would
        // read as changed and issue an UPDATE for a row nothing touched — and it would
        // serialize both dictionaries on every check. Scalars take the default comparer and
        // never serialize; only a value-object value falls through to JSON.
        Assert.Contains("if (!b.TryGetValue(kv.Key, out var other)) return false;", withMap);
        Assert.Contains("EqualityComparer<TValue>.Default.Equals(kv.Value, other)) continue;", withMap);

        // A model with no field.map must stay byte-identical -- the helper is gated, exactly
        // as the UnmappedEnumValue helper is.
        const string noMap = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Plain", "children": [
            { "source.rdb": { "@table": "plains" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var without = Assert.Single(
            new DbContextGenerator().Generate(Ctx(Load(noMap, "nomap.json")))).Content;
        Assert.DoesNotContain("MapJsonb", without);
    }

    [Fact]
    public void A_read_only_projection_map_column_also_gets_its_jsonb_mapping()
    {
        // EntityGenerator emits the Dictionary property for a PROJECTION too, but the
        // DbContext's projection loop emits only ToView + enum conversions — so a view
        // exposing a field.map got a Dictionary property with no mapping at all: no column
        // type and no converter, so only an explicit mapping makes EF agree with the jsonb
        // column the TS-owned migration creates (ADR-0015). That is exactly the failure this
        // whole mapping exists to prevent.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "CustomerSummary", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
            { "field.long":   { "name": "id" } },
            { "field.map":    { "name": "tallies", "@valueType": "int" } }
          ]}}
        ]}}
        """;
        var ctx = Ctx(Load(model, "proj.json"));

        // The property is emitted... (nullable, no initializer — the view's map column is
        // nullable like any other, and a NULL cell must read as null, not 500.)
        var entity = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        Assert.Contains("public Dictionary<string, int>? Tallies { get; set; }", entity);

        // ...so the storage mapping must be too.
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;
        Assert.Contains(
            "modelBuilder.Entity<CustomerSummary>().Property(x => x.Tallies).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<int>(), MapJsonb.Comparer<int>());",
            dbCtx);
        // ...and the helper it names must be declared, or the generated file will not compile.
        Assert.Contains("private static class MapJsonb", dbCtx);
    }

    [Fact]
    public void Generated_entities_and_value_objects_compile_together()
    {
        var ctx = Ctx(Load());
        // §A6 (task 4) — Customer now references CustomerNames.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new NamesGenerator().Generate(ctx)).ToList();
        var trees = files.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("mapfieldcompile_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity + value object should compile, got: " + string.Join("; ", errors));
    }

    // A NULL jsonb cell materializes as a null Dictionary -- the property's `= new()`
    // initializer does not survive EF's shaper -- and EF Core 8's TYPED
    // ValueComparer<T>.GetHashCode/Snapshot invoke the compiled lambdas with no null
    // guard of their own (only the object?-typed overloads guard), which is why EF's own
    // built-in comparers null-guard inside the lambdas. So the emitted Hash/Snap must
    // tolerate null exactly as Eq already does. This EXECUTES the emitted code rather
    // than matching its text: the generated files are compiled against real EF Core 8,
    // the assembly is loaded, and the comparer's own compiled lambdas -- the same
    // delegates EF change tracking calls -- are invoked with a null dictionary.
    [Fact]
    public void MapJsonb_comparer_hash_and_snapshot_tolerate_a_null_dictionary()
    {
        var ctx = Ctx(Load());
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx)).ToList();
        var trees = files.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var comp = CSharpCompilation.Create("mapnull_" + Guid.NewGuid().ToString("N"),
            trees, DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var diagnostics = comp.GetDiagnostics().ToList();
        Assert.True(diagnostics.All(d => d.Severity != DiagnosticSeverity.Error),
            "generated output should compile against EF Core 8, got: "
                + string.Join("; ", diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
                    .Select(d => d.GetMessage())));
        // The generated file stamps #nullable enable, so it must compile nullability-clean
        // as well -- the comparer's signatures carry nullable annotations.
        var nullableWarnings = diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Warning && d.Id.StartsWith("CS86"))
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(nullableWarnings.Count == 0,
            "generated output should carry no nullable-analysis warnings: "
                + string.Join("; ", nullableWarnings));

        using var pe = new MemoryStream();
        var emit = comp.Emit(pe);
        Assert.True(emit.Success,
            string.Join("; ", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => d.GetMessage())));
        var asm = Assembly.Load(pe.ToArray());

        var appDbContext = asm.GetType("Acme.Generated.AppDbContext");
        Assert.NotNull(appDbContext);
        var helper = appDbContext.GetNestedType("MapJsonb", BindingFlags.NonPublic);
        Assert.NotNull(helper);
        var comparerOf = helper.GetMethod("Comparer", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(comparerOf);
        var scalar = comparerOf.MakeGenericMethod(typeof(string)).Invoke(null, null)!;
        var voType = asm.GetType("Acme.Generated.Address");
        Assert.NotNull(voType);
        var objectValued = comparerOf.MakeGenericMethod(voType).Invoke(null, null)!;

        // A null map hashes to a stable constant and snapshots as null, on BOTH value-type
        // arms -- Hash used to dereference v.Count and the scalar Snap arm passed v to the
        // Dictionary copy constructor, so a null map threw inside EF change tracking.
        Assert.Equal(0, (int)InvokeLambda(scalar, "HashCodeExpression", (object?)null)!);
        Assert.Null(InvokeLambda(scalar, "SnapshotExpression", (object?)null));
        Assert.Equal(0, (int)InvokeLambda(objectValued, "HashCodeExpression", (object?)null)!);
        Assert.Null(InvokeLambda(objectValued, "SnapshotExpression", (object?)null));

        // Semantics beyond null handling are unchanged: entry-wise order-independent
        // equality and hashing, null-vs-instance inequality, and a snapshot that is a copy
        // rather than the same instance.
        var map = new Dictionary<string, string> { ["a"] = "1", ["b"] = "2" };
        var reordered = new Dictionary<string, string> { ["b"] = "2", ["a"] = "1" };
        var changed = new Dictionary<string, string> { ["a"] = "1", ["b"] = "9" };
        Assert.True((bool)InvokeLambda(scalar, "EqualsExpression", map, reordered)!);
        Assert.False((bool)InvokeLambda(scalar, "EqualsExpression", map, changed)!);
        Assert.False((bool)InvokeLambda(scalar, "EqualsExpression", (object?)null, map)!);
        Assert.True((bool)InvokeLambda(scalar, "EqualsExpression", (object?)null, (object?)null)!);
        Assert.Equal(
            InvokeLambda(scalar, "HashCodeExpression", map),
            InvokeLambda(scalar, "HashCodeExpression", reordered));
        var snap = InvokeLambda(scalar, "SnapshotExpression", map);
        Assert.IsType<Dictionary<string, string>>(snap);
        Assert.NotSame(map, snap);
        Assert.True((bool)InvokeLambda(scalar, "EqualsExpression", map, snap)!);
    }

    // Compiles one of the comparer's expression properties -- HashCodeExpression /
    // SnapshotExpression / EqualsExpression, the same expressions EF Core registers and
    // invokes -- and calls the resulting delegate with the given arguments.
    private static object? InvokeLambda(object comparer, string expressionProperty, params object?[] arguments)
    {
        // DeclaredOnly: ValueComparer<T> re-declares these properties with `new` over the
        // non-generic base's same-named ones, so a plain GetProperty is ambiguous.
        var lambda = (LambdaExpression)comparer.GetType()
            .GetProperty(expressionProperty, BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!
            .GetValue(comparer)!;
        return lambda.Compile().DynamicInvoke(arguments);
    }

    [Fact]
    public void Both_write_paths_validate_the_values_of_a_value_object_map()
    {
        // #362. The create path validated only field.object columns, and the PATCH merge
        // loop routed a map through the generic property path, which assigns without ever
        // running the value-object graph validation. So a map of invalid value objects was
        // written on BOTH write surfaces — silently, as a 201/200, never an error.
        var routes = new RoutesGenerator().Generate(Ctx(Load()))
            .Single(f => f.Path == "CustomerRoutes.g.cs").Content;

        // Create: the map column joins the field.object columns in the validation preamble.
        Assert.Contains("ValueObjectValidator.Validate(input.Addresses)", routes);
        // PATCH: a typed arm ahead of the generic path, so a present key is validated
        // before assignment rather than after persistence (or never).
        Assert.Contains("if (!ValueObjectValidator.Validate(__map0)) return Results.BadRequest", routes);

        // The control: a scalar-valued map has no nested bean and must reach NEITHER path.
        // Without this, an implementation that validated every map would pass the two
        // assertions above while doing something quite different.
        Assert.DoesNotContain("ValueObjectValidator.Validate(input.Labels)", routes);
        Assert.DoesNotContain("ValueObjectValidator.Validate(input.Channels)", routes);
    }
}
