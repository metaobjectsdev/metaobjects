// field.duration — the C# half of the duration wire rule, gated against the shared vectors in
// fixtures/duration-wire/vectors.json. No database: the production wire helper
// (Runtime/DurationWire.cs, the SAME text the entity generator emits into every generated project)
// runs every vector, and the emitted text is proven identical to it. The Postgres vectors (what an
// interval column reads back as, through Npgsql's native TimeSpan) are gated against a live
// database in MetaObjects.IntegrationTests/DurationPostgresTests.

using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.Runtime;
using MetaObjects.Core.Query;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Tests;

public class DurationWireTests
{
    private static JsonElement Vectors() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(
            CorpusPaths.RepoRoot(), "fixtures", "duration-wire", "vectors.json"))).RootElement;

    public static TheoryData<string, string> ParseVectors()
    {
        var data = new TheoryData<string, string>();
        foreach (var v in Vectors().GetProperty("parse").EnumerateArray())
            data.Add(v.GetProperty("in").GetString()!, v.GetProperty("out").GetString()!);
        return data;
    }

    public static TheoryData<string> RefusedVectors()
    {
        var data = new TheoryData<string>();
        foreach (var v in Vectors().GetProperty("refused").EnumerateArray()) data.Add(v.GetString()!);
        return data;
    }

    public sealed class Holder
    {
        [DurationWire.Iso] public TimeSpan Span { get; set; }
        [DurationWire.Iso] public TimeSpan? Maybe { get; set; }
        [DurationWire.Iso] public IList<TimeSpan> Many { get; set; } = new List<TimeSpan>();
    }

    [Theory, MemberData(nameof(ParseVectors))]
    public void An_accepted_duration_parses_to_its_canonical_form(string input, string canonical)
    {
        Assert.True(DurationWire.TryParse(input, out var span), $"'{input}' was refused");
        Assert.Equal(canonical, DurationWire.Format(span));
        Assert.Equal(canonical, DurationWire.Canonical(input));
        // The canonical form is a fixed point.
        Assert.Equal(canonical, DurationWire.Format(DurationWire.Parse(canonical)));
    }

    [Theory, MemberData(nameof(ParseVectors))]
    public void A_property_reads_the_accepted_form_and_writes_the_canonical_one(string input, string canonical)
    {
        var h = JsonSerializer.Deserialize<Holder>($"{{\"Span\":\"{input}\",\"Maybe\":\"{input}\",\"Many\":[\"{input}\"]}}")!;
        Assert.Equal($"{{\"Span\":\"{canonical}\",\"Maybe\":\"{canonical}\",\"Many\":[\"{canonical}\"]}}", JsonSerializer.Serialize(h));
    }

    [Theory, MemberData(nameof(RefusedVectors))]
    public void A_refused_value_is_not_a_duration(string input)
    {
        Assert.False(DurationWire.TryParse(input, out _));
        Assert.Null(DurationWire.Canonical(input));
        Assert.Throws<FormatException>(() => DurationWire.Parse(input));
        var json = JsonSerializer.Serialize(input);
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>($"{{\"Span\":{json}}}"));
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>($"{{\"Maybe\":{json}}}"));
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>($"{{\"Many\":[{json}]}}"));
    }

    [Theory]
    [InlineData("1")]              // a number is not a duration
    [InlineData("true")]
    [InlineData("{}")]
    [InlineData("\"01:30:00\"")]   // System.Text.Json's own TimeSpan form
    [InlineData("\"PT99999999999999999999H\"")] // past what a TimeSpan holds: refused, not wrapped
    public void A_non_duration_token_is_refused(string json) =>
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>($"{{\"Span\":{json}}}"));

    [Fact]
    public void Null_crosses_as_null_and_a_tick_below_a_microsecond_truncates_toward_zero()
    {
        Assert.Null(JsonSerializer.Deserialize<Holder>("{\"Maybe\":null}")!.Maybe);
        Assert.Contains("\"Maybe\":null", JsonSerializer.Serialize(new Holder()));
        Assert.Equal("PT0S", DurationWire.Format(TimeSpan.FromTicks(9)));
        Assert.Equal("PT0S", DurationWire.Format(TimeSpan.FromTicks(-9)));
        Assert.Equal("PT0.000001S", DurationWire.Format(TimeSpan.FromTicks(19)));
        Assert.Equal("-PT0.000001S", DurationWire.Format(TimeSpan.FromTicks(-19)));
        Assert.Equal("-PT1M30S", DurationWire.Format(TimeSpan.FromSeconds(-90)));
    }

    [Fact]
    public void The_magnitude_is_bounded_at_256204778_hours_exactly_on_parse_and_on_write()
    {
        var max = TimeSpan.FromHours(DurationWire.MaxHours);
        Assert.Equal("PT256204778H", DurationWire.Format(max));
        Assert.Equal("-PT256204778H", DurationWire.Format(-max));
        // A tick below a microsecond over the bound truncates back onto it; one microsecond over is refused.
        Assert.Equal("PT256204778H", DurationWire.Format(max + TimeSpan.FromTicks(9)));
        Assert.Throws<OverflowException>(() => DurationWire.Format(max + TimeSpan.FromTicks(10)));
        Assert.Throws<OverflowException>(() => DurationWire.Format(-max - TimeSpan.FromTicks(10)));
        Assert.Throws<OverflowException>(() => DurationWire.Format(TimeSpan.MaxValue));
        Assert.Throws<OverflowException>(() => DurationWire.Format(TimeSpan.MinValue));
        Assert.False(DurationWire.InRange(TimeSpan.MaxValue));
        Assert.True(DurationWire.InRange(-max));
        Assert.True(DurationWire.TryParse("PT256204777H59M59.999999S", out _));
        Assert.False(DurationWire.TryParse("PT256204778H0.000001S", out _));
        // A value past the bound is refused by the property converter on the way out, too.
        Assert.ThrowsAny<Exception>(() => JsonSerializer.Serialize(new Holder { Span = TimeSpan.MaxValue }));
    }

    // ---- filter operands ----------------------------------------------------------------------

    public sealed class Row { public TimeSpan Wait { get; set; } public TimeSpan? Grace { get; set; } }

    private static FilterParseResult Check(string field, string op, object value) =>
        EfCoreFilterDispatch.Validate<Row>(FilterParseResult.Ok([new FilterPredicate(field, op, value)]));

    [Theory]
    [InlineData("wait", "eq", "P1M")]
    [InlineData("wait", "eq", "01:30:00")]
    [InlineData("grace", "ne", "pt1h")]
    [InlineData("grace", "eq", "")]
    public void A_malformed_duration_operand_is_invalid_filter_value_naming_the_field(string field, string op, string operand)
    {
        var r = Check(field, op, operand);
        Assert.Equal("invalid_filter_value", r.ErrorEnvelope);
        Assert.Equal(field, r.Field);
    }

    [Fact]
    public void A_good_duration_operand_passes_and_an_in_list_is_checked_element_wise()
    {
        Assert.Null(Check("wait", "eq", "PT90M").ErrorEnvelope);
        Assert.Null(Check("grace", "ne", "-P1DT0.5S").ErrorEnvelope);
        Assert.Null(Check("wait", "in", new List<string> { "PT1H", "P2D" }).ErrorEnvelope);
        Assert.Equal("invalid_filter_value", Check("wait", "in", new List<string> { "PT1H", "P1Y" }).ErrorEnvelope);
    }

    [Fact]
    public void A_duration_filters_on_the_identity_band()
    {
        Assert.Equal(["eq", "ne", "in", "isNull"], QueryConstants.OpsForSubType(FIELD_SUBTYPE_DURATION));
    }

    // ---- generated code -------------------------------------------------------------------------

    private const string Model = """
    { "metadata.root": { "package": "acme::ops", "children": [
      { "object.value": { "name": "Window", "children": [
        { "field.duration": { "name": "length", "@required": true } },
        { "field.duration": { "name": "slack" } },
        { "field.duration": { "name": "steps", "isArray": true } }
      ]}},
      { "object.value": { "name": "Limits", "children": [
        { "field.duration": { "name": "cap" } },
        { "field.duration": { "name": "marks", "isArray": true } }
      ]}},
      { "object.entity": { "name": "Timer", "children": [
        { "source.rdb": { "@table": "timers" } },
        { "field.long": { "name": "id" } },
        { "field.duration": { "name": "timeout", "@required": true, "@default": "PT90M" } },
        { "field.duration": { "name": "grace", "@filterable": true } },
        { "field.duration": { "name": "backoff", "isArray": true } },
        { "field.object": { "name": "window", "@objectRef": "Window", "@storage": "jsonb" } },
        { "field.object": { "name": "limits", "@objectRef": "Limits", "@storage": "flattened" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}}
    ]}}
    """;

    private static List<EmittedFile> Emit()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "duration-model.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = Path.Combine(Path.GetTempPath(), "unused-duration"), Namespace = "Acme.Ops" },
        };
        return new IGenerator[] { new EntityGenerator(), new DbContextGenerator(), new FilterAllowlistGenerator(), new RoutesGenerator() }
            .SelectMany(g => g.Generate(ctx)).ToList();
    }

    private static Assembly Compile(IEnumerable<EmittedFile> files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path));
        var comp = CSharpCompilation.Create("duration_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return Assembly.Load(ms.ToArray());
    }

    [Fact]
    public void The_emitted_helper_is_the_production_helper_with_only_the_namespace_changed()
    {
        var emitted = Emit().Single(f => f.Path == "DurationWire.g.cs");
        var production = File.ReadAllText(Path.Combine(
            CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen", "Runtime", "DurationWire.cs")).Replace("\r\n", "\n");
        Assert.Equal(production.Replace("namespace MetaObjects.Codegen.Runtime;", "namespace Acme.Ops;"), emitted.Content.Replace("\r\n", "\n"));
    }

    [Fact]
    public void A_duration_is_a_TimeSpan_with_the_wire_converter_an_interval_on_Postgres_and_text_elsewhere()
    {
        var files = Emit();
        var timer = files.Single(f => f.Path == "Timer.g.cs").Content;
        Assert.Contains("    [DurationWire.Iso]\n    public TimeSpan Timeout { get; set; } = DurationWire.Parse(\"PT90M\");", timer.Replace("\r\n", "\n"));
        Assert.Contains("public TimeSpan? Grace { get; set; }", timer);
        Assert.Contains("public IList<TimeSpan> Backoff { get; set; } = new List<TimeSpan>();", timer);
        Assert.DoesNotContain("using MetaObjects", timer);

        var window = files.Single(f => f.Path == "Window.g.cs").Content;
        Assert.Contains("[DurationWire.Iso]", window);

        var ctx = files.Single(f => f.Path == "AppDbContext.g.cs").Content.Replace("\r\n", "\n");
        Assert.Contains(
            "        if (Database.ProviderName == \"Npgsql.EntityFrameworkCore.PostgreSQL\")\n" +
            "            modelBuilder.Entity<Timer>().Property(x => x.Timeout).HasColumnType(\"interval\");\n" +
            "        else\n" +
            "            modelBuilder.Entity<Timer>().Property(x => x.Timeout).HasConversion(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(" +
            "v => global::Acme.Ops.DurationWire.Format(v), v => global::Acme.Ops.DurationWire.Parse(v)));",
            ctx);
        Assert.Contains(
            "        if (Database.ProviderName != \"Npgsql.EntityFrameworkCore.PostgreSQL\")\n" +
            "            modelBuilder.Entity<Timer>().PrimitiveCollection(x => x.Backoff).ElementType().HasConversion(",
            ctx);
        // A duration member of a jsonb value object is stored as its canonical string on every provider.
        Assert.Contains("b.Property(p => p.Length).HasConversion(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(", ctx);
        Assert.Contains("b.PrimitiveCollection(p => p.Steps).ElementType().HasConversion(", ctx);
        // ...and a duration member of a FLATTENED value object takes the top-level column mapping:
        // native on Postgres, the canonical-string converter elsewhere.
        Assert.Contains(
            "            b.Property(p => p.Cap).HasColumnName(\"limits_cap\");\n" +
            "            if (Database.ProviderName != \"Npgsql.EntityFrameworkCore.PostgreSQL\")\n" +
            "                b.Property(p => p.Cap).HasConversion(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(" +
            "v => global::Acme.Ops.DurationWire.Format(v), v => global::Acme.Ops.DurationWire.Parse(v)));",
            ctx);
        Assert.Contains(
            "            if (Database.ProviderName != \"Npgsql.EntityFrameworkCore.PostgreSQL\")\n" +
            "                b.PrimitiveCollection(p => p.Marks).ElementType().HasConversion(",
            ctx);

        var allowlist = files.Single(f => f.Path == "TimerFilterAllowlist.g.cs").Content;
        Assert.Contains("[\"grace\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"in\", \"isNull\" },", allowlist);

        // The PATCH merge reads a duration through the wire helper, not System.Text.Json's own form.
        var routes = files.Single(f => f.Path == "TimerRoutes.g.cs").Content;
        Assert.Contains("if (clr == typeof(System.TimeSpan))", routes);
        Assert.Contains("DurationWire.TryParseElement(prop.Value, out var __dur)", routes);
    }

    [Fact]
    public void The_generated_entity_compiles_and_crosses_json_in_the_canonical_form()
    {
        var asm = Compile(Emit());
        var timer = asm.GetType("Acme.Ops.Timer")!;

        var fresh = Activator.CreateInstance(timer)!;
        Assert.Equal(TimeSpan.FromMinutes(90), timer.GetProperty("Timeout")!.GetValue(fresh)); // @default

        var row = JsonSerializer.Deserialize(
            "{\"Id\":1,\"Timeout\":\"P1DT2H\",\"Grace\":\"-PT90S\",\"Backoff\":[\"PT1S\",\"PT0.5S\"],\"Window\":{\"length\":\"PT5400S\",\"steps\":[\"P1D\"]}}",
            timer)!;
        var json = JsonSerializer.Serialize(row, timer);
        Assert.Contains("\"Timeout\":\"PT26H\"", json);
        Assert.Contains("\"Grace\":\"-PT1M30S\"", json);
        Assert.Contains("\"Backoff\":[\"PT1S\",\"PT0.5S\"]", json);
        // A value object's members cross under their metadata (camelCase) names.
        Assert.Contains("\"length\":\"PT1H30M\"", json);
        Assert.Contains("\"slack\":null", json);
        Assert.Contains("\"steps\":[\"PT24H\"]", json);

        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize("{\"Timeout\":\"01:30:00\"}", timer));
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize("{\"Grace\":\"P1M\"}", timer));
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize("{\"Backoff\":[\"P1W\"]}", timer));
    }
}
