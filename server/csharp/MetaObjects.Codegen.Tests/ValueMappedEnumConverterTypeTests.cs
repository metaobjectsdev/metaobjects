// A scalar value-mapped field.enum (@intValueMap or @stringValueMap) is converted by an explicit
// ValueConverter typed on the NON-nullable enum, whether the field is required or optional.
//
// The lambda pair used to be passed straight to HasConversion(...), so EF typed it on the
// property's CLR type — ValueConverter<E?, int> for an optional field. Npgsql EF 8 cannot build
// the JSON collection reader for a parameterised `Contains` over such a property, so
// `active.Contains(w.Status)` failed at runtime: an InvalidOperationException ("When building an
// array mapping over 'Nullable`1', the JsonValueReaderWriter for element mapping ... is incorrect")
// on the EF 8.0.10 this repository pins, and a MissingMethodException on
// JsonNullableStructCollectionReaderWriter`3[E?[], E?[], E] on 8.0.11 and later. A converter on `E` is what EF's own built-in
// enum converters are, and what the array branch's element converter already was. The member
// chains themselves are unchanged. The live query is
// MetaObjects.IntegrationTests/ValueMappedEnumContainsPostgresTests.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ValueMappedEnumConverterTypeTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT", "LIVE"],
            "@intValueMap": { "DRAFT": 0, "LIVE": 5 } } },
        { "field.enum": { "name": "grade", "@required": true, "@values": ["LOW", "HIGH"],
            "@intValueMap": { "LOW": 1, "HIGH": 9 } } },
        { "field.enum": { "name": "phase", "@maxLength": 12, "@values": ["OPEN", "SHUT"],
            "@stringValueMap": { "OPEN": "open_v1", "SHUT": "shut_v1" } } },
        { "field.enum": { "name": "stage", "@required": true, "@maxLength": 10, "@values": ["NEW", "OLD"],
            "@stringValueMap": { "NEW": "new", "OLD": "old" } } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private const string Converter = "new global::Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<";

    private static GenContext Ctx()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "value-mapped-enum.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutputLayout = OutputLayout.Package, PackageNamespacesFromMetadata = true, OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
        };
    }

    private static string DbContext(GenContext ctx) =>
        Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

    private const string Owner = "global::Acme.Widget";

    [Fact]
    public void An_optional_int_mapped_enum_is_converted_on_the_non_nullable_enum()
    {
        var e = $"{Owner}.WidgetStatus";
        Assert.Contains(
            $"modelBuilder.Entity<{Owner}>().Property(x => x.Status).HasConversion({Converter}{e}, int>("
            + $"v => v == {e}.DRAFT ? 0 : v == {e}.LIVE ? 5 : UnmappedEnumMember(v, \"status\"), "
            + $"v => v == 0 ? {e}.DRAFT : v == 5 ? {e}.LIVE : UnmappedEnumValue<{e}>(v, \"status\")));",
            DbContext(Ctx()));
    }

    [Fact]
    public void A_required_int_mapped_enum_is_converted_on_the_enum()
    {
        var e = $"{Owner}.WidgetGrade";
        Assert.Contains(
            $"modelBuilder.Entity<{Owner}>().Property(x => x.Grade).HasConversion({Converter}{e}, int>("
            + $"v => v == {e}.LOW ? 1 : v == {e}.HIGH ? 9 : UnmappedEnumMember(v, \"grade\"), "
            + $"v => v == 1 ? {e}.LOW : v == 9 ? {e}.HIGH : UnmappedEnumValue<{e}>(v, \"grade\")));",
            DbContext(Ctx()));
    }

    [Fact]
    public void An_optional_string_mapped_enum_is_converted_on_the_non_nullable_enum_and_keeps_its_length()
    {
        var e = $"{Owner}.WidgetPhase";
        Assert.Contains(
            $"modelBuilder.Entity<{Owner}>().Property(x => x.Phase).HasConversion({Converter}{e}, string>("
            + $"v => v == {e}.OPEN ? \"open_v1\" : v == {e}.SHUT ? \"shut_v1\" : UnmappedEnumStoredMember(v, \"phase\"), "
            + $"v => v == \"open_v1\" ? {e}.OPEN : v == \"shut_v1\" ? {e}.SHUT : UnmappedEnumStoredValue<{e}>(v, \"phase\"))).HasMaxLength(12);",
            DbContext(Ctx()));
    }

    [Fact]
    public void A_required_string_mapped_enum_is_converted_on_the_enum_and_keeps_its_length()
    {
        var e = $"{Owner}.WidgetStage";
        Assert.Contains(
            $"modelBuilder.Entity<{Owner}>().Property(x => x.Stage).HasConversion({Converter}{e}, string>("
            + $"v => v == {e}.NEW ? \"new\" : v == {e}.OLD ? \"old\" : UnmappedEnumStoredMember(v, \"stage\"), "
            + $"v => v == \"new\" ? {e}.NEW : v == \"old\" ? {e}.OLD : UnmappedEnumStoredValue<{e}>(v, \"stage\"))).HasMaxLength(10);",
            DbContext(Ctx()));
    }

    // The typed converter compiles against EF Core 8 on a nullable property and a non-nullable
    // one alike (PropertyBuilder<E?>.HasConversion(ValueConverter) takes a converter on E).
    [Fact]
    public void The_typed_converters_compile_against_EF_Core_8()
    {
        var ctx = Ctx();
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create(
            "value_mapped_enum_" + Guid.NewGuid().ToString("N"), sources, DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0, "generated code should compile:\n" + string.Join("\n", errors));
    }
}
