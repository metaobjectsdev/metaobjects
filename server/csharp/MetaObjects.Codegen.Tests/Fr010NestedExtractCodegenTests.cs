// FR-010 Plan 2.1 (nested codegen gap) — the compile-AND-RUN proof for the runtime-DELEGATING
// extract overload in the C# port.
//
// A payload with a single nested object (address) + an array-of-objects (items) is generated,
// compiled via Roslyn ALONGSIDE the render engine + MetaObjects.Codegen (which hosts the runtime
// ExtractObject the generated delegating overload wraps), then the delegating
// ExtractLenient(MetaObject, dirtyJson) is invoked with a loaded MetaObject. The proof: nested-object and
// array-of-object components POPULATE into the typed nullable mirror graph (NOT null), reading the
// live metadata directly. Mirrors the Java/Kotlin/TS/Python nested proofs.

using System.Collections;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class Fr010NestedExtractCodegenTests
{
    // A payload with a single nested object (Address) and an array-of-objects (LineItem).
    private const string NestedModel = """
    { "metadata.root": { "package": "acme::orders", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true } },
        { "field.string": { "name": "city" } },
        { "field.enum":   { "name": "kind", "@values": ["HOME","WORK"] } }
      ]}},
      { "object.value": { "name": "LineItem", "children": [
        { "field.string": { "name": "sku", "@required": true } },
        { "field.int":    { "name": "qty" } }
      ]}},
      { "object.value": { "name": "OrderPayload", "children": [
        { "field.string": { "name": "orderId", "@required": true } },
        { "field.object": { "name": "shipTo", "@objectRef": "Address" } },
        { "field.object": { "name": "items", "isArray": true, "@objectRef": "LineItem" } }
      ]}},
      { "template.prompt": { "name": "OrderOutput", "@payloadRef": "OrderPayload", "@responseRef": "OrderPayload",
          "@textRef": "ai/order", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } }
    ]}}
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "orders.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // ---- emission shape ----

    [Fact]
    public void Parser_emits_delegating_overload_and_nested_aware_mirror()
    {
        var src = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(NestedModel)))).Content;

        // The delegating overload + the loader convenience overload + the baked FQN.
        Assert.Contains("public const string PAYLOAD_FQN = \"OrderPayload\";", src);
        Assert.Contains("public static global::MetaObjects.Render.Extract.ExtractionResult<OrderPayloadExtracted> ExtractLenient(\n        global::MetaObjects.Meta.MetaObject mo, string text, ExtractOptions? opts = null)", src);
        Assert.Contains("global::MetaObjects.Meta.MetaRoot root, string text, ExtractOptions? opts = null)", src);
        Assert.Contains("global::MetaObjects.Codegen.Runtime.ExtractObject.Extract(mo, text, Format.Json, opts)", src);

        // Move 1: the self-contained / baked ExtractLenient(string) path is gone.
        Assert.DoesNotContain("ExtractLenient(string text)", src);
        Assert.DoesNotContain("ExtractSchemaDef", src);

        // Nested-aware mirror typing — object fields are nested mirrors, NOT object?.
        Assert.Contains("public AddressExtracted? shipTo { get; init; }", src);
        Assert.Contains("public global::System.Collections.Generic.IReadOnlyList<LineItemExtracted?>? items { get; init; }", src);
        // Nested mirror records emitted.
        Assert.Contains("public sealed record AddressExtracted", src);
        Assert.Contains("public sealed record LineItemExtracted", src);
        // Mappers + helpers emitted.
        Assert.Contains("FromAddressExtracted(ReadProp(o, \"shipTo\"))", src);
        Assert.Contains("MapObjectList(ReadProp(o, \"items\"), FromLineItemExtracted)", src);
        Assert.Contains("private static object? ReadProp(object? o, string name)", src);
    }

    // ---- compile-AND-run proof ----

    [Fact]
    public void Generated_delegating_extract_populates_nested_and_array_of_objects()
    {
        var root = Load(NestedModel);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "OrderPayload");

        var asm = CompileToAssembly(parserSrc, payloadSrc);

        // Resolve the runtime MetaObject and invoke the delegating ExtractLenient(MetaObject, text).
        var parserType = asm.GetType("Acme.Generated.OrderOutputParser")!;
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaObject), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;

        MetaObject orderMo = root.FindObject("OrderPayload")!;

        // Dirty JSON: chat preamble + fence, a nested object, and an array-of-objects.
        const string dirty =
            "Sure! Here you go:\n```json\n" +
            "{ \"orderId\": \"A-100\"," +
            "  \"shipTo\": { \"street\": \"1 Main St\", \"city\": \"Springfield\", \"kind\": \"HOME\" }," +
            "  \"items\": [ { \"sku\": \"X1\", \"qty\": 2 }, { \"sku\": \"Y2\", \"qty\": 5 } ] }\n```";

        var result = extract.Invoke(null, new object?[] { orderMo, dirty, null })!;
        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;

        Assert.Equal("A-100", data.GetType().GetProperty("orderId")!.GetValue(data));

        // --- nested object POPULATES (not null) ---
        var shipTo = data.GetType().GetProperty("shipTo")!.GetValue(data);
        Assert.NotNull(shipTo);
        Assert.Equal("1 Main St", shipTo!.GetType().GetProperty("street")!.GetValue(shipTo));
        Assert.Equal("Springfield", shipTo.GetType().GetProperty("city")!.GetValue(shipTo));
        Assert.Equal("HOME", shipTo.GetType().GetProperty("kind")!.GetValue(shipTo));

        // --- array-of-objects POPULATES (not null), each element typed + populated ---
        var items = (IEnumerable)data.GetType().GetProperty("items")!.GetValue(data)!;
        Assert.NotNull(items);
        var itemList = items.Cast<object>().ToList();
        Assert.Equal(2, itemList.Count);
        Assert.Equal("X1", itemList[0].GetType().GetProperty("sku")!.GetValue(itemList[0]));
        Assert.Equal(2, itemList[0].GetType().GetProperty("qty")!.GetValue(itemList[0]));
        Assert.Equal("Y2", itemList[1].GetType().GetProperty("sku")!.GetValue(itemList[1]));
        Assert.Equal(5, itemList[1].GetType().GetProperty("qty")!.GetValue(itemList[1]));

        // --- the report is non-empty and nothing required was lost ---
        var report = result.GetType().GetProperty("Report")!.GetValue(result)!;
        Assert.False((bool)report.GetType().GetProperty("IsEmpty")!.GetValue(report)!);
        Assert.False((bool)report.GetType().GetMethod("HasLostRequired")!.Invoke(report, null)!);
    }

    [Fact]
    public void Loader_convenience_overload_resolves_payload_and_populates_nested()
    {
        var root = Load(NestedModel);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "OrderPayload");
        var asm = CompileToAssembly(parserSrc, payloadSrc);

        var parserType = asm.GetType("Acme.Generated.OrderOutputParser")!;
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaRoot), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;

        const string dirty = "{ \"orderId\": \"A-200\", \"shipTo\": { \"street\": \"9 Elm\" }, \"items\": [] }";
        var result = extract.Invoke(null, new object?[] { root, dirty, null })!;
        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;

        Assert.Equal("A-200", data.GetType().GetProperty("orderId")!.GetValue(data));
        var shipTo = data.GetType().GetProperty("shipTo")!.GetValue(data);
        Assert.NotNull(shipTo);
        Assert.Equal("9 Elm", shipTo!.GetType().GetProperty("street")!.GetValue(shipTo));
    }

    private static Assembly CompileToAssembly(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        // The delegating extract references the render engine, MetaObjects core (MetaObject /
        // MetaRoot / ValueObject) AND MetaObjects.Codegen (which hosts the runtime ExtractObject).
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            .WithSpecificDiagnosticOptions(new Dictionary<string, ReportDiagnostic>
            {
                ["CS8619"] = ReportDiagnostic.Error, // nullable-covariance mismatch must fail the proof
            });
        var comp = CSharpCompilation.Create("fr010nested_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
