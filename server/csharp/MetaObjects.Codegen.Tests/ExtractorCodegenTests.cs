// Cross-port Extractor codegen (Task 3, C#) — the compile-AND-RUN proof for the `extract` tier.
//
// The Extractor sits OVER the existing nested-capable runtime-delegating recover
// (<Name>OutputParser.Recover(MetaObject, text)) and turns dirty LLM text into the STRICT typed
// payload record (PayloadCodegen's immutable `sealed record` with `required init` props) in one
// call: run recover, throw ExtractException iff a @required field was lost, else map the
// all-nullable <Name>Recovered mirror onto the strict <Name> via a generated recursive
// mirror->strict mapper (recurse nested objects + arrays-of-objects; one-shot object-initializer
// construct). recover is re-exposed unchanged. NO registry / binding / factory.
//
// NOTE on optionality (C#-specific). PayloadCodegen emits EVERY payload field as `required
// {NonNullableType}` (it does not honor @required) — the strict record has no nullable/optional
// props. So the mirror->strict mapper matches that predicate exactly: every field is mapped as
// required (m.F! / ToStrict_X(m.F!) / array maps), with NO optional-null variant (there is no
// nullable property to assign null to). A field absent from the recovered mirror that the strict
// record types non-null therefore must be present in the input — consistent with the strict
// `Parse` path's `required`-keyword semantics. The lost-REQUIRED gate (ExtractException) fires
// only for fields the metadata marks @required:true.

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

public sealed class ExtractorCodegenTests
{
    // template.output "OrderOut" -> payload "Order":
    //   • orderId : required scalar
    //   • customer: REQUIRED single nested Customer{ name (required) }
    //   • lines   : REQUIRED array-of-objects Line{ sku (required), qty:int }
    //   • tags    : REQUIRED scalar-array string[]
    //   • note    : scalar (not @required)
    //   • shipTo  : single nested Customer (not @required)
    private const string Model = """
    { "metadata.root": { "package": "acme::orders", "children": [
      { "object.value": { "name": "Customer", "children": [
        { "field.string": { "name": "name", "@required": true } }
      ]}},
      { "object.value": { "name": "Line", "children": [
        { "field.string": { "name": "sku", "@required": true } },
        { "field.int":    { "name": "qty" } }
      ]}},
      { "object.value": { "name": "Order", "children": [
        { "field.string": { "name": "orderId", "@required": true } },
        { "field.object": { "name": "customer", "@required": true, "@objectRef": "Customer" } },
        { "field.object": { "name": "lines", "isArray": true, "@required": true, "@objectRef": "Line" } },
        { "field.string": { "name": "tags", "isArray": true, "@required": true } },
        { "field.string": { "name": "note" } },
        { "field.object": { "name": "shipTo", "@objectRef": "Customer" } }
      ]}},
      { "template.output": { "name": "OrderOut", "@payloadRef": "Order",
          "@textRef": "ai/order", "@format": "json", "@promptStyle": "guide" } }
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
    public void Extractor_emits_extract_recover_and_recursive_mappers()
    {
        var src = Assert.Single(new ExtractorGenerator().Generate(Ctx(Load(Model)))).Content;

        // Extractor class named off the strict payload type.
        Assert.Contains("public static class OrderExtractor", src);

        // extract(MetaObject, text) returns the STRICT record + the opts overload.
        Assert.Contains("public static Order Extract(", src);
        Assert.Contains("global::MetaObjects.Meta.MetaObject mo, string text)", src);
        Assert.Contains("RecoverOptions opts", src);

        // routes through the NESTED-CAPABLE delegating recover (NOT the self-contained Recover(string)).
        Assert.Contains("OrderOutParser.Recover(mo, text", src);

        // throws ExtractException on lost-required.
        Assert.Contains("HasLostRequired()", src);
        Assert.Contains("throw new ExtractException(", src);

        // re-exposes recover (returns the mirror result).
        Assert.Contains("RecoveryResult<OrderRecovered> Recover(", src);

        // recursive mirror->strict mappers: one per type in the graph.
        Assert.Contains("ToStrict_Order(", src);
        Assert.Contains("ToStrict_Customer(", src);
        Assert.Contains("ToStrict_Line(", src);

        // scalar-array drops nulls (mirror IReadOnlyList<string?>? -> strict IReadOnlyList<string>).
        Assert.Contains(".Where(", src);
        // object-array maps element-wise via the element mapper.
        Assert.Contains("Select(ToStrict_Line)", src);
    }

    // ---- compile-AND-run proof ----

    [Fact]
    public void Generated_extract_populates_strict_graph_from_dirty_text()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderExtractor")!;
        var extract = extractorType.GetMethod("Extract",
            new[] { typeof(MetaObject), typeof(string) })!;

        MetaObject orderMo = root.FindObject("Order")!;

        // Dirty: chat preamble + fenced json + a trailing comma.
        const string dirty =
            "Sure! Here you go:\n```json\n" +
            "{ \"orderId\": \"A-100\"," +
            "  \"customer\": { \"name\": \"Ada\" }," +
            "  \"lines\": [ { \"sku\": \"A\", \"qty\": 2 }, { \"sku\": \"B\", \"qty\": 5 } ]," +
            "  \"tags\": [\"x\", \"y\"]," +
            "  \"shipTo\": { \"name\": \"Grace\" }, }\n```";

        var order = extract.Invoke(null, new object?[] { orderMo, dirty })!;

        Assert.Equal("A-100", order.GetType().GetProperty("orderId")!.GetValue(order));

        // required single nested populates + is the strict element type.
        var customer = order.GetType().GetProperty("customer")!.GetValue(order)!;
        Assert.Equal("Customer", customer.GetType().Name);
        Assert.Equal("Ada", customer.GetType().GetProperty("name")!.GetValue(customer));

        // required array-of-objects populates, each element strict + populated.
        var lines = ((IEnumerable)order.GetType().GetProperty("lines")!.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(2, lines.Count);
        Assert.Equal("A", lines[0].GetType().GetProperty("sku")!.GetValue(lines[0]));
        Assert.Equal(2, lines[0].GetType().GetProperty("qty")!.GetValue(lines[0]));

        // required scalar-array populates with NO null elements (drop-null projection).
        var tags = ((IEnumerable)order.GetType().GetProperty("tags")!.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { "x", "y" }, tags.ToArray());

        // non-@required single nested, present -> populates.
        var shipTo = order.GetType().GetProperty("shipTo")!.GetValue(order)!;
        Assert.Equal("Grace", shipTo.GetType().GetProperty("name")!.GetValue(shipTo));
    }

    [Fact]
    public void Generated_extract_throws_on_lost_required()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderExtractor")!;
        var extract = extractorType.GetMethod("Extract", new[] { typeof(MetaObject), typeof(string) })!;
        MetaObject orderMo = root.FindObject("Order")!;

        // Missing the REQUIRED customer (and lines/tags/orderId) -> lost-required -> throws.
        var ex = Assert.Throws<TargetInvocationException>(() =>
            extract.Invoke(null, new object?[] { orderMo, "{ \"lines\": [] }" }));
        Assert.IsType<MetaObjects.Render.Recover.ExtractException>(ex.InnerException);
    }

    [Fact]
    public void Re_exposed_recover_never_throws_on_clean_input()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderExtractor")!;
        var recover = extractorType.GetMethod("Recover", new[] { typeof(MetaObject), typeof(string) })!;
        MetaObject orderMo = root.FindObject("Order")!;

        const string clean =
            "{ \"orderId\": \"A-7\", \"customer\": { \"name\": \"Ada\" }," +
            "  \"lines\": [ { \"sku\": \"A\", \"qty\": 1 } ], \"tags\": [\"a\"] }";

        var result = recover.Invoke(null, new object?[] { orderMo, clean })!;
        var report = result.GetType().GetProperty("Report")!.GetValue(result)!;
        Assert.False((bool)report.GetType().GetMethod("HasLostRequired")!.Invoke(report, null)!);
    }

    private static Assembly Compile(MetaRoot root)
    {
        var ctx = Ctx(root);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(ctx)).Content;
        var extractorSrc = Assert.Single(new ExtractorGenerator().Generate(ctx)).Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n"
            + PayloadCodegen.GeneratePayloadRecords(root, "Order");

        var trees = new[] { parserSrc, extractorSrc, payloadSrc }
            .Select(s => CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.Recover.RecoverSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Codegen.Runtime.RecoverObject).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            .WithSpecificDiagnosticOptions(new Dictionary<string, ReportDiagnostic>
            {
                ["CS8619"] = ReportDiagnostic.Error, // nullable-covariance mismatch must fail the proof
            });
        var comp = CSharpCompilation.Create("extractor_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
