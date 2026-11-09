// field.duration — the C# half of the duration wire rule, gated against the shared vectors in
// fixtures/duration-wire/vectors.json. No database: the production wire helper
// (Runtime/DurationWire.cs, the SAME text the entity generator emits into every generated project)
// runs every `wire` vector (the `precision` ones at seven digits: a TimeSpan tick is 100 ns), and
// the emitted text is proven identical to it. Of the `codecs` groups C# has two in production:
// `storedMicros` (the generated value converter on SQLite and MySQL, here) and the Postgres read
// (`postgres` and `postgresRefused`, through the generated NpgsqlInterval mapping, gated against a
// live database in MetaObjects.IntegrationTests/Api/DurationWireGeneratedApiTests). C# never spells
// a duration as Postgres text (Npgsql binds a TimeSpan natively), so `postgresText` is not its codec.

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

    private static JsonElement Wire(string group) => Vectors().GetProperty("wire").GetProperty(group);

    // The `precision` key for this port: the fractional digits a TimeSpan holds.
    private const string PrecisionKey = "7";

    public static TheoryData<string, string> ParseVectors()
    {
        var data = new TheoryData<string, string>();
        foreach (var v in Wire("parse").EnumerateArray())
            data.Add(v.GetProperty("in").GetString()!, v.GetProperty("out").GetString()!);
        return data;
    }

    public static TheoryData<string, string> PrecisionVectors()
    {
        var data = new TheoryData<string, string>();
        foreach (var v in Wire("precision").EnumerateArray())
            data.Add(v.GetProperty("in").GetString()!, v.GetProperty("out").GetProperty(PrecisionKey).GetString()!);
        return data;
    }

    public static TheoryData<string> RefusedVectors()
    {
        var data = new TheoryData<string>();
        foreach (var v in Wire("refused").EnumerateArray()) data.Add(v.GetString()!);
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

    [Theory, MemberData(nameof(PrecisionVectors))]
    public void A_fraction_keeps_whole_ticks_and_truncates_the_rest_toward_zero(string input, string canonical)
    {
        Assert.True(DurationWire.TryParse(input, out var span), $"'{input}' was refused");
        Assert.Equal(canonical, DurationWire.Format(span));
        Assert.Equal(canonical, DurationWire.Format(DurationWire.Parse(canonical)));
    }

    [Theory, MemberData(nameof(ParseVectors)), MemberData(nameof(PrecisionVectors))]
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
    public void Null_crosses_as_null_and_every_tick_is_written()
    {
        Assert.Null(JsonSerializer.Deserialize<Holder>("{\"Maybe\":null}")!.Maybe);
        Assert.Contains("\"Maybe\":null", JsonSerializer.Serialize(new Holder()));
        Assert.Equal("PT0.0000009S", DurationWire.Format(TimeSpan.FromTicks(9)));
        Assert.Equal("-PT0.0000009S", DurationWire.Format(TimeSpan.FromTicks(-9)));
        Assert.Equal("PT0.0000019S", DurationWire.Format(TimeSpan.FromTicks(19)));
        Assert.Equal("-PT0.0000019S", DurationWire.Format(TimeSpan.FromTicks(-19)));
        Assert.Equal("-PT1M30S", DurationWire.Format(TimeSpan.FromSeconds(-90)));
        Assert.Equal(TimeSpan.FromTicks(-19), DurationWire.Parse("-PT0.00000199S")); // truncated toward zero
    }

    public static TheoryData<string, string> StoredMicrosVectors()
    {
        var data = new TheoryData<string, string>();
        foreach (var v in Vectors().GetProperty("codecs").GetProperty("storedMicros").EnumerateArray())
            data.Add(v.GetProperty("in").GetString()!, v.GetProperty("out").GetString()!);
        return data;
    }

    [Theory, MemberData(nameof(StoredMicrosVectors))]
    public void On_a_database_without_an_interval_a_duration_is_its_microsecond_count(string duration, string micros)
    {
        var count = long.Parse(micros, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(count, DurationWire.ToMicros(DurationWire.Parse(duration)));
        // The column's precision is a microsecond: what reads back is the span to the microsecond.
        Assert.Equal(TimeSpan.FromTicks(count * 10), DurationWire.FromMicros(count));
        Assert.Equal(count, DurationWire.ToMicros(DurationWire.FromMicros(count)));
    }

    // C#'s own limit — a TimeSpan's range, about 10.7 million days — not a cross-port one: a span
    // past it is refused, never wrapped, on parse and on a stored microsecond count. The whole
    // range is reachable, to the tick, MinValue (one tick longer than MaxValue) included.
    [Fact]
    public void A_span_past_a_timespan_is_refused_never_wrapped()
    {
        Assert.Equal("PT256204778H48M5.4775807S", DurationWire.Format(TimeSpan.MaxValue));
        Assert.Equal("-PT256204778H48M5.4775808S", DurationWire.Format(TimeSpan.MinValue));
        Assert.Equal(TimeSpan.MaxValue, DurationWire.Parse("PT256204778H48M5.4775807S"));
        Assert.Equal(TimeSpan.MaxValue, DurationWire.Parse("PT256204778H48M5.47758079999S")); // truncated, not rounded past
        Assert.Equal(TimeSpan.MinValue, DurationWire.Parse("-PT256204778H48M5.4775808S"));
        Assert.Equal("PT256204778H", DurationWire.Format(DurationWire.Parse("PT256204778H")));
        Assert.Equal("-PT256204778H", DurationWire.Format(DurationWire.Parse("-P10675199DT2H")));
        Assert.Equal("PT256204704H", DurationWire.Format(DurationWire.Parse("P1525028W")));
        foreach (var past in new[] {
            "PT256204778H48M5.4775808S", "-PT256204778H48M5.4775809S", "PT256204779H", "P10675200D",
            "P1525029W", "P1525028W4D", "-PT256204779H", "PT99999999999999999999S", "P99999999999999999999W" })
            Assert.False(DurationWire.TryParse(past, out _), past);
        Assert.Equal(TimeSpan.MaxValue.Ticks / 10, DurationWire.ToMicros(TimeSpan.MaxValue));
        Assert.Throws<OverflowException>(() => DurationWire.FromMicros(long.MaxValue));
        Assert.Throws<OverflowException>(() => DurationWire.FromMicros(long.MinValue));
        Assert.Equal(-1, DurationWire.ToMicros(TimeSpan.FromTicks(-19))); // truncated toward zero
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
        Assert.Null(Check("wait", "in", new List<string> { "PT1H", "P2D", "P1W" }).ErrorEnvelope);
        Assert.Equal("invalid_filter_value", Check("wait", "in", new List<string> { "PT1H", "P1Y" }).ErrorEnvelope);
    }

    [Fact]
    public void A_duration_filters_on_the_ordered_band()
    {
        Assert.Equal(["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], QueryConstants.OpsForSubType(FIELD_SUBTYPE_DURATION));
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
        var emitted = Emit().Single(f => System.IO.Path.GetFileName(f.Path) == "DurationWire.g.cs");
        var production = File.ReadAllText(Path.Combine(
            CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen", "Runtime", "DurationWire.cs")).Replace("\r\n", "\n");
        Assert.Equal(production.Replace("namespace MetaObjects.Codegen.Runtime;", "namespace Acme.Ops;"), emitted.Content.Replace("\r\n", "\n"));
    }

    [Fact]
    public void A_duration_is_a_TimeSpan_with_the_wire_converter_an_interval_on_Postgres_and_text_elsewhere()
    {
        var files = Emit();
        var timer = files.Single(f => System.IO.Path.GetFileName(f.Path) == "Timer.g.cs").Content;
        Assert.Contains("    [DurationWire.Iso]\n    public TimeSpan Timeout { get; set; } = DurationWire.Parse(\"PT90M\");", timer.Replace("\r\n", "\n"));
        Assert.Contains("public TimeSpan? Grace { get; set; }", timer);
        Assert.Contains("public IList<TimeSpan> Backoff { get; set; } = new List<TimeSpan>();", timer);
        Assert.DoesNotContain("using MetaObjects", timer);

        var window = files.Single(f => System.IO.Path.GetFileName(f.Path) == "Window.g.cs").Content;
        Assert.Contains("[DurationWire.Iso]", window);

        var ctx = files.Single(f => System.IO.Path.GetFileName(f.Path) == "AppDbContext.g.cs").Content.Replace("\r\n", "\n");
        const string Npgsql = "if (Database.ProviderName == \"Npgsql.EntityFrameworkCore.PostgreSQL\")";
        const string Micros = "new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, long>(" +
            "v => global::Acme.Ops.DurationWire.ToMicros(v), v => global::Acme.Ops.DurationWire.FromMicros(v))";
        // Npgsql: the native interval, read through the generated NpgsqlInterval mapping; anything
        // else: an integer count of microseconds.
        Assert.Contains(
            $"        {Npgsql}\n" +
            "            modelBuilder.Entity<Timer>().Property(x => x.Timeout).HasColumnType(\"interval\").Metadata.SetTypeMapping(DurationInterval.Mapping);\n" +
            "        else\n" +
            $"            modelBuilder.Entity<Timer>().Property(x => x.Timeout).HasConversion({Micros});",
            ctx);
        Assert.Contains(
            $"        {Npgsql}\n" +
            "            modelBuilder.Entity<Timer>().PrimitiveCollection(x => x.Backoff).Metadata.SetTypeMapping(DurationInterval.ArrayMapping);\n" +
            "        else\n" +
            $"            modelBuilder.Entity<Timer>().PrimitiveCollection(x => x.Backoff).ElementType().HasConversion({Micros});",
            ctx);
        Assert.Contains("internal static class DurationInterval", ctx);
        Assert.DoesNotContain("using Npgsql", ctx);
        // A duration member of a jsonb value object is stored as its canonical string on every provider.
        Assert.Contains("b.Property(p => p.Length).HasConversion(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(", ctx);
        Assert.Contains("b.PrimitiveCollection(p => p.Steps).ElementType().HasConversion(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(", ctx);
        // ...and a duration member of a FLATTENED value object takes the top-level column mapping.
        Assert.Contains(
            "            b.Property(p => p.Cap).HasColumnName(\"limits_cap\");\n" +
            $"            {Npgsql}\n" +
            "                b.Property(p => p.Cap).HasColumnType(\"interval\").Metadata.SetTypeMapping(DurationInterval.Mapping);\n" +
            "            else\n" +
            $"                b.Property(p => p.Cap).HasConversion({Micros});",
            ctx);
        Assert.Contains($"                b.PrimitiveCollection(p => p.Marks).ElementType().HasConversion({Micros});", ctx);

        var allowlist = files.Single(f => System.IO.Path.GetFileName(f.Path) == "TimerFilterAllowlist.g.cs").Content;
        Assert.Contains("[\"grace\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\" },", allowlist);

        // The PATCH merge reads a duration through the wire helper, not System.Text.Json's own form.
        var routes = files.Single(f => System.IO.Path.GetFileName(f.Path) == "TimerRoutes.g.cs").Content;
        Assert.Contains("if (clr == typeof(System.TimeSpan))", routes);
        Assert.Contains("DurationWire.TryParseElement(prop.Value, out var __dur)", routes);
    }

    // Stand-ins for NpgsqlTypes.NpgsqlInterval: the shape the generated Npgsql mapping reads, and two
    // that have drifted from it.
    public readonly struct IntervalLike { public int Months { get; } public int Days { get; } public long Time { get; } }
    public readonly struct IntervalWithoutMonths { public int Days { get; } public long Time { get; } }
    public readonly struct IntervalWithIntTime { public int Months { get; } public int Days { get; } public int Time { get; } }

    [Fact]
    public void The_npgsql_mapping_names_what_is_missing_when_the_interval_shape_has_changed()
    {
        var asm = Compile(Emit());
        var shape = asm.GetType("Acme.Ops.DurationInterval+IntervalShape")!;
        var problem = shape.GetMethod("Problem", BindingFlags.NonPublic | BindingFlags.Static)!;
        string? Check(Type? t) => (string?)problem.Invoke(null, [t]);

        Assert.Null(Check(typeof(IntervalLike)));
        Assert.Contains("no type NpgsqlTypes.NpgsqlInterval was found", Check(null));
        var noMonths = Check(typeof(IntervalWithoutMonths))!;
        Assert.Contains("has no Int32 Months property", noMonths);
        Assert.Contains("tested with Npgsql 8.0.5", noMonths);
        Assert.Contains("has no Int64 Time property", Check(typeof(IntervalWithIntTime)));
        Assert.Equal("NpgsqlTypes.NpgsqlInterval, Npgsql", shape.GetField("TypeName", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null));
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
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize("{\"Backoff\":[\"P1Y\"]}", timer));
    }
}
