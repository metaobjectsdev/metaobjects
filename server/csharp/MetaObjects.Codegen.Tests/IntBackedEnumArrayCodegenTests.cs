// An int-backed field.enum ARRAY (@intValueMap + isArray) in the generated AppDbContext.
//
// Each element persists as its declared int (an EF Core 8 primitive collection whose element
// converter is the @intValueMap pair) and reads back as its member, wherever the field is
// mapped: an entity column, a member of a flattened value object, and a projection column.
// The live Postgres round trip is MetaObjects.IntegrationTests/IntBackedEnumArrayPostgresTests.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class IntBackedEnumArrayCodegenTests
{
    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "ivm-array.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
    };

    private static IReadOnlyList<string> CompileErrors(GenContext ctx)
    {
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create(
            "ivm_array_" + Guid.NewGuid().ToString("N"), sources, DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
    }

    private static string DbContext(GenContext ctx) =>
        Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

    // The UnmappedEnumValue<T> helper is emitted only when some converter calls it. A
    // flattened value object's ARRAY enum member gets the same element converter as an
    // entity-level one, so when that member is the model's ONLY int-backed enum the helper
    // must still be emitted, or the generated file does not compile (CS0103).
    [Fact]
    public void A_flattened_value_objects_int_backed_array_member_alone_still_gets_the_helper()
    {
        var ctx = Ctx(Load("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "street" } },
            { "field.enum":   { "name": "tags", "isArray": true, "@values": ["A", "B"],
                "@intValueMap": { "A": 1, "B": 2 } } }
          ]}},
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "home", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """));

        var dbctx = DbContext(ctx);
        Assert.Contains("b.PrimitiveCollection(p => p.Tags).HasColumnName(\"home_tags\").ElementType()"
            + ".HasConversion(new global::Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<Address.AddressTags, int>(v => v == Address.AddressTags.A ? 1 : v == Address.AddressTags.B ? 2 : UnmappedEnumMember(v, \"tags\"), "
            + "v => v == 1 ? Address.AddressTags.A : v == 2 ? Address.AddressTags.B : UnmappedEnumValue<Address.AddressTags>(v, \"tags\")));",
            dbctx);
        Assert.Contains("private static T UnmappedEnumValue<T>(int stored, string field)", dbctx);

        var errors = CompileErrors(ctx);
        Assert.True(errors.Count == 0, "generated code should compile:\n" + string.Join("\n", errors));
    }

    // A projection (view) column that holds an enum ARRAY needs the same element converter
    // the table side gets. Without one, EF maps the List<TEnum> by its ORDINAL default: an
    // int-backed array then reads its stored ints as ordinals, silently naming the wrong
    // members (5 is not PUBLISHED's ordinal), and a string-backed one reads text[] as int[].
    [Fact]
    public void A_projections_enum_array_column_gets_the_element_converter()
    {
        var ctx = Ctx(Load("""
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true,
              "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
              "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
          { "object.projection": { "name": "DocSummary", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_doc_summary" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "history", "extends": "acme::Status", "isArray": true } },
            { "field.enum": { "name": "labels", "isArray": true, "@values": ["X", "Y"] } }
          ]}}
        ]}}
        """));

        var dbctx = DbContext(ctx);
        Assert.Contains("modelBuilder.Entity<DocSummary>().PrimitiveCollection(x => x.History).ElementType()"
            + ".HasConversion(new global::Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<Status, int>(v => v == Status.DRAFT ? 0 : v == Status.PUBLISHED ? 5 : v == Status.ARCHIVED ? 9 : UnmappedEnumMember(v, \"history\"), "
            + "v => v == 0 ? Status.DRAFT : v == 5 ? Status.PUBLISHED : v == 9 ? Status.ARCHIVED : UnmappedEnumValue<Status>(v, \"history\")));",
            dbctx);
        Assert.Contains("modelBuilder.Entity<DocSummary>().PrimitiveCollection(x => x.Labels).ElementType().HasConversion<string>();",
            dbctx);
        Assert.Contains("private static T UnmappedEnumValue<T>(int stored, string field)", dbctx);

        var errors = CompileErrors(ctx);
        Assert.True(errors.Count == 0, "generated code should compile:\n" + string.Join("\n", errors));
    }

    // The entity-level path, the shape adopters write: the map inherited from a shared
    // abstract enum by both a scalar and an array field.
    [Fact]
    public void An_entity_array_inheriting_a_shared_map_gets_the_element_converter_and_compiles()
    {
        var ctx = Ctx(Load("""
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true,
              "@values": ["DRAFT", "PUBLISHED"],
              "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } },
          { "object.entity": { "name": "Doc", "children": [
            { "source.rdb": { "@table": "docs" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "current", "extends": "acme::Status" } },
            { "field.enum": { "name": "history", "extends": "acme::Status", "isArray": true } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """));

        var dbctx = DbContext(ctx);
        Assert.Contains("modelBuilder.Entity<Doc>().PrimitiveCollection(x => x.History).ElementType()"
            + ".HasConversion(new global::Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<Status, int>(v => v == Status.DRAFT ? 0 : v == Status.PUBLISHED ? 5 : UnmappedEnumMember(v, \"history\"), "
            + "v => v == 0 ? Status.DRAFT : v == 5 ? Status.PUBLISHED : UnmappedEnumValue<Status>(v, \"history\")));",
            dbctx);

        var errors = CompileErrors(ctx);
        Assert.True(errors.Count == 0, "generated code should compile:\n" + string.Join("\n", errors));
    }

    // A non-required int-backed array's column is nullable, and NULL must read back as null
    // (not crash materialization), so its property is a nullable IList<T> with no initializer —
    // the rule a non-required decimal array already follows. A @required one keeps the
    // non-nullable, empty-initialised IList<T>. A flattened value object's member follows the
    // same rule.
    [Fact]
    public void A_non_required_int_backed_array_is_a_nullable_list()
    {
        var ctx = Ctx(Load("""
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true,
              "@values": ["DRAFT", "PUBLISHED"],
              "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } },
          { "object.value": { "name": "Address", "children": [
            { "field.enum": { "name": "tags", "extends": "acme::Status", "isArray": true } }
          ]}},
          { "object.entity": { "name": "Doc", "children": [
            { "source.rdb": { "@table": "docs" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "history", "extends": "acme::Status", "isArray": true } },
            { "field.enum": { "name": "trail", "extends": "acme::Status", "isArray": true, "@required": true } },
            { "field.object": { "name": "home", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """));

        var files = new EntityGenerator().Generate(ctx).ToList();
        var doc = files.Single(f => f.Path == "Doc.g.cs").Content;
        Assert.Contains("public IList<Status>? History { get; set; }\n", doc.Replace("\r\n", "\n"));
        Assert.Contains("public IList<Status> Trail { get; set; } = new List<Status>();", doc);
        var address = files.Single(f => f.Path == "Address.g.cs").Content;
        Assert.Contains("public IList<Status>? Tags { get; set; }", address);

        var errors = CompileErrors(ctx);
        Assert.True(errors.Count == 0, "generated code should compile:\n" + string.Join("\n", errors));
    }
}
