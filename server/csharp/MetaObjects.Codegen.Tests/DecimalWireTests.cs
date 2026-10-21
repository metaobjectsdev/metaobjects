// ADR-0019 Amendment 1 (W1-W4) — the C# half of the decimal wire rule, gated against the
// shared vectors in fixtures/decimal-wire/vectors.json. No database: the production wire
// helper (Runtime/DecimalWire.cs, the SAME text the entity generator emits into every
// generated project) runs every vector, and the emitted text is proven identical to it.
// The HTTP bytes and the read path are gated by the api-contract and persistence lanes.

using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.Runtime;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class DecimalWireTests
{
    private static JsonElement Vectors() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(
            CorpusPaths.RepoRoot(), "fixtures", "decimal-wire", "vectors.json"))).RootElement;

    private static decimal Exact(string s) =>
        decimal.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);

    public static TheoryData<string> Section(string name)
    {
        var data = new TheoryData<string>();
        foreach (var v in Vectors().GetProperty(name).EnumerateArray()) data.Add(v.GetRawText());
        return data;
    }

    public static TheoryData<string> FormatVectors => Section("format");
    public static TheoryData<string> ParseVectors => Section("parse");
    public static TheoryData<string> OperandVectors => Section("filterOperand");
    public static TheoryData<string> Double15Vectors => Section("double15");

    public sealed class Holder
    {
        [JsonConverter(typeof(DecimalWire.DecimalJsonConverter))]
        public decimal Amount { get; set; }

        [JsonConverter(typeof(DecimalWire.NullableDecimalJsonConverter))]
        public decimal? Maybe { get; set; }

        [JsonConverter(typeof(DecimalWire.DecimalListJsonConverter))]
        public IList<decimal> Many { get; set; } = new List<decimal>();
    }

    [Theory, MemberData(nameof(FormatVectors))]
    public void W1_format(string vector)
    {
        var v = JsonDocument.Parse(vector).RootElement;
        Assert.Equal(v.GetProperty("out").GetString(), DecimalWire.Format(Exact(v.GetProperty("in").GetString()!)));
    }

    [Theory, MemberData(nameof(FormatVectors))]
    public void W1_a_property_serializes_the_canonical_string_under_any_host_options(string vector)
    {
        var v = JsonDocument.Parse(vector).RootElement;
        var want = v.GetProperty("out").GetString()!;
        // Host options that would otherwise write a number, and one that would try to read strings as numbers.
        var host = new JsonSerializerOptions { NumberHandling = JsonNumberHandling.AllowReadingFromString };
        var json = JsonSerializer.Serialize(new Holder { Amount = Exact(v.GetProperty("in").GetString()!), Maybe = null }, host);
        Assert.Equal($"{{\"Amount\":\"{want}\",\"Maybe\":null,\"Many\":[]}}", json);
    }

    [Theory, MemberData(nameof(ParseVectors))]
    public void W2_body_parse(string vector)
    {
        var v = JsonDocument.Parse(vector).RootElement;
        var json = v.GetProperty("json").GetString()!;
        var body = $"{{\"Amount\":{(json == "null" ? "0" : json)},\"Maybe\":{json}}}";
        if (v.TryGetProperty("error", out var err) && err.GetBoolean())
        {
            // The generated routes turn this exception into 400 {"error":"validation"}.
            Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>(body));
            return;
        }
        var parsed = JsonSerializer.Deserialize<Holder>(body)!;
        var value = v.GetProperty("value");
        if (value.ValueKind == JsonValueKind.Null) Assert.Null(parsed.Maybe);
        else
        {
            Assert.Equal(Exact(value.GetString()!), parsed.Maybe);
            Assert.Equal(Exact(value.GetString()!), parsed.Amount);
        }
    }

    [Theory, MemberData(nameof(OperandVectors))]
    public void W2_filter_operand(string vector)
    {
        var v = JsonDocument.Parse(vector).RootElement;
        var ok = DecimalWire.TryParse(v.GetProperty("text").GetString(), out var got);
        if (v.TryGetProperty("error", out var err) && err.GetBoolean()) { Assert.False(ok); return; }
        Assert.True(ok);
        Assert.Equal(Exact(v.GetProperty("value").GetString()!), got);
    }

    [Theory, MemberData(nameof(Double15Vectors))]
    public void W4_double_rendered_at_15_significant_digits(string vector)
    {
        var v = JsonDocument.Parse(vector).RootElement;
        var d = double.Parse(v.GetProperty("double").GetString()!, NumberStyles.Float, CultureInfo.InvariantCulture);
        Assert.Equal(v.GetProperty("out").GetString(), DecimalWire.FormatDouble15(d));
    }

    [Theory]
    [InlineData("\"79228162514264337593543950336\"")] // decimal.MaxValue + 1
    [InlineData("\"1e30\"")]
    [InlineData("\"1e-30\"")]                          // would round to 0, never silently
    [InlineData("\"0.12345678901234567890123456789012\"")] // 32 fractional digits
    [InlineData("1e999999999999")]
    public void W3_a_value_decimal_cannot_hold_is_refused_not_rounded(string json) =>
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>($"{{\"Amount\":{json}}}"));

    [Theory]
    [InlineData("0.1234567890", 28, 10, true)]
    [InlineData("0.12345678901", 28, 10, false)]
    [InlineData("12345678901234567.8901234567", 28, 10, true)]
    [InlineData("1234567890123456789", 28, 10, false)]
    [InlineData("-0.5", 1, 1, true)]
    [InlineData("1.5", 1, 1, false)]
    [InlineData("100.2500", 5, 2, true)]
    [InlineData("1000", 5, 2, false)]
    public void W3_a_declared_precision_and_scale_bound_the_input(string text, int precision, int scale, bool fits)
    {
        Assert.True(DecimalWire.TryParse(text, out var value));
        Assert.Equal(fits, DecimalWire.Fits(value, precision, scale));
    }

    [Fact]
    public void W3_the_28_digit_edge_is_accepted()
    {
        var h = JsonSerializer.Deserialize<Holder>("{\"Amount\":\"1234567890123456789012345678\"}")!;
        Assert.Equal(1234567890123456789012345678m, h.Amount);
        Assert.Equal(decimal.MaxValue, JsonSerializer.Deserialize<Holder>("{\"Amount\":\"79228162514264337593543950335\"}")!.Amount);
    }

    [Fact]
    public void An_array_of_decimals_crosses_as_canonical_strings()
    {
        var h = JsonSerializer.Deserialize<Holder>("{\"Many\":[\"1.50\",2,\"0.10\"]}")!;
        Assert.Equal(new[] { 1.5m, 2m, 0.1m }, h.Many);
        Assert.Contains("\"Many\":[\"1.5\",\"2\",\"0.1\"]", JsonSerializer.Serialize(h));
        Assert.ThrowsAny<JsonException>(() => JsonSerializer.Deserialize<Holder>("{\"Many\":[\"abc\"]}"));
    }

    public sealed class Row { public decimal Amount { get; set; } public int Count { get; set; } }

    private static FilterParseResult Check(string field, string op, object value) =>
        EfCoreFilterDispatch.Validate<Row>(FilterParseResult.Ok([new FilterPredicate(field, op, value)]));

    [Theory]
    [InlineData("amount", "eq", "abc")]
    [InlineData("amount", "gt", " 1")]
    [InlineData("amount", "lt", "0x10")]
    [InlineData("amount", "eq", "")]
    [InlineData("amount", "eq", "+1")]
    [InlineData("amount", "eq", "1e30")]   // outside decimal: refused, not rounded
    [InlineData("count", "eq", "abc")]      // every typed operand shares the one envelope
    public void A_malformed_operand_is_invalid_filter_value_naming_the_field(string field, string op, string operand)
    {
        var r = Check(field, op, operand);
        Assert.Equal("invalid_filter_value", r.ErrorEnvelope);
        Assert.Equal(field, r.Field);
    }

    [Fact]
    public void A_good_operand_passes_and_an_in_list_is_checked_element_wise()
    {
        Assert.Null(Check("amount", "eq", "12345678901234567.89").ErrorEnvelope);
        Assert.Null(Check("amount", "gte", "1e-7").ErrorEnvelope);
        Assert.Null(Check("amount", "in", new List<string> { "1", "2.50" }).ErrorEnvelope);
        Assert.Equal("invalid_filter_value", Check("amount", "in", new List<string> { "1", "x" }).ErrorEnvelope);
    }

    [Fact]
    public void A_driver_decimal_overflow_anywhere_in_the_chain_is_recognized()
    {
        var overflow = new OverflowException("Value was either too large or too small for a Decimal.");
        Assert.True(DecimalRangeEndpointFilter.IsDecimalOverflow(new InvalidOperationException("wrapped", overflow)));
        Assert.False(DecimalRangeEndpointFilter.IsDecimalOverflow(new OverflowException("Arithmetic operation resulted in an overflow.")));
        Assert.False(DecimalRangeEndpointFilter.IsDecimalOverflow(new InvalidOperationException("boom")));
    }

    // ---- the emitted copy IS the production helper -------------------------------------------


    private static IReadOnlyList<EmittedFile> EmitFitness(out MetaRoot root)
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusPaths.FitnessMetadata)]);
        Assert.Empty(result.Errors);
        root = result.Root;
        root.PhysicalNaming = CorpusPaths.Naming;
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig
            {
                OutDir = Path.Combine(Path.GetTempPath(), "unused-decimal-wire"),
                Namespace = "Decimal.Wire.Generated",
                ColumnNamingStrategy = CorpusPaths.Naming.Columns,
                EmitAbstractShapes = false,
            },
        };
        return new IGenerator[] { new EntityGenerator(), new DbContextGenerator(), new FilterAllowlistGenerator(), new CallableGenerator() }
            .SelectMany(g => g.Generate(ctx)).ToList();
    }

    [Fact]
    public void The_emitted_helper_is_the_production_helper_with_only_the_namespace_changed()
    {
        var files = EmitFitness(out _);
        var emitted = files.Where(f => f.Path == "DecimalWire.g.cs").ToList();
        Assert.NotEmpty(emitted);
        var production = File.ReadAllText(Path.Combine(
            CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen", "Runtime", "DecimalWire.cs")).Replace("\r\n", "\n");
        foreach (var f in emitted)
        {
            var ns = f.Content.Split('\n').First(l => l.StartsWith("namespace ", StringComparison.Ordinal));
            Assert.Equal(
                production.Replace("namespace MetaObjects.Codegen.Runtime;", ns),
                f.Content.Replace("\r\n", "\n"));
            Assert.DoesNotContain("MetaObjects", ns.Replace("namespace ", ""), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Every_generated_decimal_property_carries_its_converter_and_the_output_serializes_canonically()
    {
        var files = EmitFitness(out _);
        // No generated entity code may import MetaObjects at runtime (CLAUDE.md).
        foreach (var f in files.Where(f => f.Path.EndsWith(".g.cs", StringComparison.Ordinal) && !f.Path.Contains("Routes")))
            if (f.Content.Contains("DecimalWire.", StringComparison.Ordinal))
                Assert.DoesNotContain("MetaObjects.Codegen", f.Content);

        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path));
        var comp = CSharpCompilation.Create("decimal_wire_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var asm = Assembly.Load(ms.ToArray());

        var decimals = asm.GetTypes().SelectMany(t => t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(p => p.PropertyType == typeof(decimal) || p.PropertyType == typeof(decimal?)
                || p.PropertyType == typeof(IList<decimal>)).ToList();
        Assert.NotEmpty(decimals);
        foreach (var p in decimals)
            Assert.True(p.GetCustomAttribute<JsonConverterAttribute>() is { } a
                    && (a.ConverterType?.DeclaringType?.Name == "DecimalWire" || a.GetType().DeclaringType?.Name == "DecimalWire"),
                $"{p.DeclaringType!.Name}.{p.Name} has no per-property DecimalWire converter");

        // A real generated entity: AllTypes.decVal is a @required field.decimal(18,6).
        var allTypes = asm.GetTypes().Single(t => t.Name == "AllTypes");
        var instance = Activator.CreateInstance(allTypes)!;
        allTypes.GetProperty("DecVal")!.SetValue(instance, 12.500000m);
        var json = JsonSerializer.Serialize(instance, allTypes, new JsonSerializerOptions { NumberHandling = JsonNumberHandling.AllowReadingFromString });
        Assert.Contains("\"DecVal\":\"12.5\"", json);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize("{\"DecVal\":\"abc\"}", allTypes));
        var back = JsonSerializer.Deserialize("{\"DecVal\":\"123456789012.89\"}", allTypes)!;
        Assert.Equal(123456789012.89m, allTypes.GetProperty("DecVal")!.GetValue(back));

        // W3: decVal is decimal(18,6). Seven fraction digits, or thirteen integer digits, are refused, never rounded.
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize("{\"DecVal\":\"0.1234567\"}", allTypes));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize("{\"DecVal\":\"1234567890123\"}", allTypes));
        var edge = JsonSerializer.Deserialize("{\"DecVal\":\"123456789012.123456\"}", allTypes)!;
        Assert.Equal(123456789012.123456m, allTypes.GetProperty("DecVal")!.GetValue(edge));
    }
}
