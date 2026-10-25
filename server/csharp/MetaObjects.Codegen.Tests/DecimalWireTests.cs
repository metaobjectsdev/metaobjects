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
        root.WireFormat = CorpusPaths.Wire;
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

    // C1 (captain ruling A): a decimal inside a jsonb value object follows the top-level rule.
    private const string ValueObjectModel = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.value": { "name": "Price", "children": [
        { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
        { "field.decimal": { "name": "free" } }
      ]}},
      { "object.entity": { "name": "Item", "children": [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
        { "field.object": { "name": "prices", "@objectRef": "Price", "isArray": true, "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // ADR-0019 Amendment 2: the cross-port form a project opts into, and the form the corpora pin.
    private static readonly WireFormat Portable = new(DecimalWireForm.String, NullMemberForm.Omit);

    private static IReadOnlyList<EmittedFile> EmitModel(string model, WireFormat? wire, GenConfig? config = null)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "wire-model.json")]);
        Assert.Empty(r.Errors);
        if (wire is not null) r.Root.WireFormat = wire;
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = config ?? new GenConfig { OutDir = Path.Combine(Path.GetTempPath(), "unused-wire-model"), Namespace = "Acme.Shop" },
        };
        return new EntityGenerator().Generate(ctx).ToList();
    }

    private static Assembly Compile(IEnumerable<EmittedFile> files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path));
        var comp = CSharpCompilation.Create("wire_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return Assembly.Load(ms.ToArray());
    }

    [Fact]
    public void A_decimal_inside_a_jsonb_value_object_reads_exactly_checks_its_declared_range_and_writes_canonical()
    {
        var asm = Compile(EmitModel(ValueObjectModel, Portable));
        var price = asm.GetTypes().Single(t => t.Name == "Price");
        var item = asm.GetTypes().Single(t => t.Name == "Item");

        string Net(string json) => JsonDocument.Parse(JsonSerializer.Serialize(JsonSerializer.Deserialize(json, price), price))
            .RootElement.GetProperty("net").GetString()!;

        // A string or a JSON number, read exactly; written as the canonical string.
        Assert.Equal("1.5", Net("{\"net\":\"1.5000\"}"));
        Assert.Equal("1234567890.12", Net("{\"net\":1234567890.12}"));
        Assert.Equal("0", Net("{\"net\":\"0.00\"}"));
        // Past the declared @precision/@scale is refused, never rounded.
        foreach (var bad in new[] { "{\"net\":\"1.234\"}", "{\"net\":1.234}", "{\"net\":\"12345678901\"}",
                                     "{\"net\":\"NaN\"}", "{\"net\":\"\"}" })
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize(bad, price));
        // A VO decimal with no @precision is bounded only by what decimal holds.
        var free = JsonSerializer.Deserialize("{\"net\":\"1\",\"free\":\"1.2345678901234567890123\"}", price)!;
        Assert.Equal(1.2345678901234567890123m, price.GetProperty("Free")!.GetValue(free));
        // The single and the array-of-VO members of the entity follow the same rule.
        var back = JsonSerializer.Deserialize(
            "{\"Price\":{\"net\":\"2.50\"},\"Prices\":[{\"net\":3},{\"net\":\"4.10\"}]}", item)!;
        var outJson = JsonDocument.Parse(JsonSerializer.Serialize(back, item)).RootElement;
        Assert.Equal("2.5", outJson.GetProperty("Price").GetProperty("net").GetString());
        Assert.Equal("3", outJson.GetProperty("Prices")[0].GetProperty("net").GetString());
        Assert.Equal("4.1", outJson.GetProperty("Prices")[1].GetProperty("net").GetString());
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize("{\"Prices\":[{\"net\":\"1.001\"}]}", item));
    }

    [Fact]
    public void FitsDeclared_finds_the_declared_range_on_an_entity_carrying_another_namespaces_copy_of_the_helper()
    {
        // A route mounted in a namespace other than the entity's resolves THIS DecimalWire while the
        // entity's property carries the DeclaredAttribute of its own namespace's copy (review C4).
        // Both wire forms: the native Number attribute carries the declared range as Declared does.
        foreach (var wire in new[] { Portable, WireFormat.Default })
        {
            var price = Compile(EmitModel(ValueObjectModel, wire)).GetTypes().Single(t => t.Name == "Price");
            Assert.True(DecimalWire.FitsDeclared(price, "Net", 99999999.99m));
            Assert.False(DecimalWire.FitsDeclared(price, "Net", 1.001m));
            Assert.False(DecimalWire.FitsDeclared(price, "Net", 123456789012m));
            Assert.True(DecimalWire.FitsDeclared(price, "Free", 1.2345678901234567890123m));
        }
    }

    private const string ArrayShapeModel = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.value": { "name": "Labels", "children": [
        { "field.string": { "name": "tags", "isArray": true } }
      ]}},
      { "object.entity": { "name": "BaseTagged", "abstract": true, "children": [
        { "field.string": { "name": "tags", "isArray": true } }
      ]}},
      { "object.entity": { "name": "Post", "extends": "BaseTagged", "children": [
        { "source.rdb": { "@table": "posts" } },
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "labels", "@objectRef": "Labels", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void A_non_decimal_array_inherited_from_an_abstract_shape_starts_empty_while_a_value_object_one_is_omitted_when_null()
    {
        var asm = Compile(EmitModel(ArrayShapeModel, Portable));

        var post = asm.GetTypes().Single(t => t.Name == "Post");
        var tags = Assert.IsAssignableFrom<IList<string>>(post.GetProperty("Tags")!.GetValue(Activator.CreateInstance(post)));
        Assert.Empty(tags);

        var labels = asm.GetTypes().Single(t => t.Name == "Labels");
        Assert.Equal("{}", JsonSerializer.Serialize(Activator.CreateInstance(labels), labels));
    }

    // ---- ADR-0019 Amendment 2: the wire setting -----------------------------------------------

    private const string NativeShapeModel = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.value": { "name": "Price", "children": [
        { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
        { "field.string": { "name": "note" } },
        { "field.string": { "name": "tags", "isArray": true } }
      ]}},
      { "object.entity": { "name": "Item", "children": [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { "name": "id" } },
        { "field.decimal": { "name": "amount", "@precision": 10, "@scale": 2 } },
        { "field.decimal": { "name": "ratio" } },
        { "field.decimal": { "name": "steps", "isArray": true } },
        { "field.object": { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void The_native_default_writes_what_System_Text_Json_writes_and_keeps_the_input_rules()
    {
        // No setting at all: the 1.0.x shape. A decimal is a JSON number carrying its scale, a
        // value object's null member is null with its key present, an unset array member is [].
        var asm = Compile(EmitModel(NativeShapeModel, wire: null));
        var item = asm.GetTypes().Single(t => t.Name == "Item");
        var price = asm.GetTypes().Single(t => t.Name == "Price");
        var vo = Activator.CreateInstance(price)!;
        price.GetProperty("Net")!.SetValue(vo, 12.50m);
        var row = Activator.CreateInstance(item)!;
        item.GetProperty("Amount")!.SetValue(row, 12.50m);
        item.GetProperty("Ratio")!.SetValue(row, 0.0000001m);
        item.GetProperty("Steps")!.SetValue(row, new List<decimal> { 1.50m, 2m });
        item.GetProperty("Price")!.SetValue(row, vo);

        var json = JsonSerializer.Serialize(row, item);
        Assert.Contains("\"Amount\":12.50", json);
        Assert.Contains("\"Ratio\":0.0000001", json);
        Assert.Contains("\"Steps\":[1.50,2]", json);
        Assert.Contains("\"Price\":{\"net\":12.50,\"note\":null,\"tags\":[]}", json);

        // W2/W3 hold in native mode: a string or a number is read, garbage and over-scale refused.
        var back = JsonSerializer.Deserialize("{\"Amount\":\"12.5\",\"Ratio\":3}", item)!;
        Assert.Equal(12.5m, item.GetProperty("Amount")!.GetValue(back));
        foreach (var bad in new[] { "{\"Amount\":\"abc\"}", "{\"Amount\":1.234}", "{\"Amount\":\"123456789\"}",
                                     "{\"Price\":{\"net\":\"1.001\"}}", "{\"Steps\":[\"x\"]}" })
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize(bad, item));
        Assert.True(DecimalWire.FitsDeclared(item, "Amount", 12345678.12m));
        Assert.False(DecimalWire.FitsDeclared(item, "Amount", 1.001m));
    }

    [Fact]
    public void The_portable_setting_writes_canonical_strings_and_omits_null_members()
    {
        var asm = Compile(EmitModel(NativeShapeModel, Portable));
        var item = asm.GetTypes().Single(t => t.Name == "Item");
        var price = asm.GetTypes().Single(t => t.Name == "Price");
        var vo = Activator.CreateInstance(price)!;
        price.GetProperty("Net")!.SetValue(vo, 12.50m);
        var row = Activator.CreateInstance(item)!;
        item.GetProperty("Amount")!.SetValue(row, 12.50m);
        item.GetProperty("Steps")!.SetValue(row, new List<decimal> { 1.50m, 2m });
        item.GetProperty("Price")!.SetValue(row, vo);

        var json = JsonSerializer.Serialize(row, item);
        Assert.Contains("\"Amount\":\"12.5\"", json);
        Assert.Contains("\"Steps\":[\"1.5\",\"2\"]", json);
        Assert.Contains("\"Price\":{\"net\":\"12.5\"}", json);
    }

    [Fact]
    public void Each_wire_key_switches_only_its_own_output()
    {
        string Gen(WireFormat w) => string.Join("\n", EmitModel(NativeShapeModel, w).Select(f => f.Path + "\n" + f.Content));
        var native = Gen(WireFormat.Default);
        // C#'s standard serializer writes a null member with its key: `emit` generates what native does.
        Assert.Equal(native, Gen(new WireFormat(DecimalWireForm.Native, NullMemberForm.Emit)));
        Assert.DoesNotContain("WhenWritingNull", native, StringComparison.Ordinal);
        Assert.DoesNotContain("DecimalWire.Declared", native, StringComparison.Ordinal);

        var stringOnly = Gen(new WireFormat(DecimalWireForm.String, NullMemberForm.Native));
        Assert.Contains("[DecimalWire.Declared(10, 2)]", stringOnly, StringComparison.Ordinal);
        Assert.DoesNotContain("WhenWritingNull", stringOnly, StringComparison.Ordinal);

        var omitOnly = Gen(new WireFormat(DecimalWireForm.Native, NullMemberForm.Omit));
        Assert.Contains("[DecimalWire.Number(10, 2)]", omitOnly, StringComparison.Ordinal);
        Assert.Contains("WhenWritingNull", omitOnly, StringComparison.Ordinal);
    }

    private const string TwoNamespaceModel = """
    { "metadata.root": { "package": "acme::billing", "children": [
      { "object.entity": { "name": "Invoice", "children": [
        { "source.rdb": { "@table": "invoices" } },
        { "field.long": { "name": "id" } },
        { "field.decimal": { "name": "total" } },
        { "field.uri": { "name": "link" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private const string SecondNamespaceModel = """
    { "metadata.root": { "package": "acme::shipping", "children": [
      { "object.entity": { "name": "Parcel", "children": [
        { "source.rdb": { "@table": "parcels" } },
        { "field.long": { "name": "id" } },
        { "field.decimal": { "name": "weight" } },
        { "field.uri": { "name": "tracking" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Helpers_for_packages_bound_to_different_namespaces_get_distinct_file_names()
    {
        // #454: two namespaces in one output directory each need DecimalWire and MetaNetValidation;
        // both copies used to be named DecimalWire.g.cs, and gen refused the duplicate path.
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(TwoNamespaceModel, id: "billing.json"),
            new InMemoryStringSource(SecondNamespaceModel, id: "shipping.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig
            {
                OutDir = Path.Combine(Path.GetTempPath(), "unused-two-ns"),
                Namespace = "Acme",
                PackageNamespaces = new() { ["acme::billing"] = "Acme.Billing", ["acme::shipping"] = "Acme.Shipping" },
            },
        };
        var files = new EntityGenerator().Generate(ctx);
        var paths = files.Select(f => f.Path).ToList();
        Assert.Equal(paths.Count, paths.Distinct(StringComparer.Ordinal).Count());
        Assert.Contains("DecimalWire.Acme.Billing.g.cs", paths);
        Assert.Contains("DecimalWire.Acme.Shipping.g.cs", paths);
        Assert.Contains("MetaNetValidation.Acme.Billing.g.cs", paths);
        Assert.Contains("MetaNetValidation.Acme.Shipping.g.cs", paths);
        Compile(files);
    }

    [Fact]
    public void Shared_helpers_carry_the_generated_marker_on_their_first_line()
    {
        var files = EmitFitness(out _);
        var helpers = files.Where(f =>
            f.Path.StartsWith("DecimalWire", StringComparison.Ordinal) ||
            f.Path.StartsWith("MetaNetValidation", StringComparison.Ordinal)).ToList();
        Assert.Contains(helpers, f => f.Path.StartsWith("DecimalWire", StringComparison.Ordinal));
        Assert.Contains(helpers, f => f.Path.StartsWith("MetaNetValidation", StringComparison.Ordinal));
        foreach (var f in helpers)
            Assert.Equal(CodegenRunner.GeneratedMarker, f.Content.Split('\n')[0].Replace("// ", ""));
    }

    [Fact]
    public void Rerun_without_a_state_dir_rewrites_the_helpers_in_every_namespace()
    {
        // #460: with no GenStateDir the runner falls back to the marker rule, and the helpers
        // lacked the marker, so every run after the first refused to overwrite them.
        var dir = Path.Combine(Path.GetTempPath(), "mo-helper-marker-" + Guid.NewGuid().ToString("N"));
        try
        {
            var r = new MetaDataLoader().Load([
                new InMemoryStringSource(TwoNamespaceModel, id: "billing.json"),
                new InMemoryStringSource(SecondNamespaceModel, id: "shipping.json")]);
            Assert.Empty(r.Errors);
            var config = new GenConfig
            {
                OutDir = dir,
                Namespace = "Acme",
                PackageNamespaces = new() { ["acme::billing"] = "Acme.Billing", ["acme::shipping"] = "Acme.Shipping" },
            };
            string[] helpers =
            [
                "DecimalWire.Acme.Billing.g.cs", "DecimalWire.Acme.Shipping.g.cs",
                "MetaNetValidation.Acme.Billing.g.cs", "MetaNetValidation.Acme.Shipping.g.cs",
            ];
            CodegenRunner.Run(config, r.Root, [new EntityGenerator()]);
            foreach (var h in helpers) File.WriteAllText(Path.Combine(dir, h), File.ReadAllText(Path.Combine(dir, h)) + "// stale\n");

            var second = CodegenRunner.Run(config, r.Root, [new EntityGenerator()]);
            Assert.DoesNotContain(second.Warnings, w => w.Contains("refusing to overwrite", StringComparison.Ordinal));
            foreach (var h in helpers)
            {
                Assert.Contains(second.Files, f => f.Path == h && f.Status == "written");
                Assert.DoesNotContain("// stale", File.ReadAllText(Path.Combine(dir, h)), StringComparison.Ordinal);
            }
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
