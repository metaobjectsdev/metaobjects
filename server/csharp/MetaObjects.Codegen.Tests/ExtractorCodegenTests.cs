// Cross-port Extractor codegen (Task 3, C#) — the compile-AND-RUN proof for the `extract` tier.
//
// The Extractor sits OVER the existing nested-capable runtime-delegating extract
// (<Name>OutputParser.ExtractLenient(MetaObject, text)) and turns dirty LLM text into the STRICT typed
// payload record (PayloadCodegen's immutable `sealed record` with `required init` props) in one
// call: run extract, throw ExtractException iff a @required field was lost, else map the
// all-nullable <Name>Extracted mirror onto the strict <Name> via a generated recursive
// mirror->strict mapper (recurse nested objects + arrays-of-objects; one-shot object-initializer
// construct). extract is re-exposed unchanged. NO registry / binding / factory.
//
// NOTE on optionality (C#-specific). PayloadCodegen emits EVERY payload field as `required
// {NonNullableType}` (it does not honor @required) — the strict record has no nullable/optional
// props. So the mirror->strict mapper matches that predicate exactly: every field is mapped as
// required (m.F! / ToStrict_X(m.F!) / array maps), with NO optional-null variant (there is no
// nullable property to assign null to). A field absent from the extracted mirror that the strict
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
    //   • scores  : REQUIRED scalar-array int[]   (kind-typed mirror element regression guard)
    //   • quantities: REQUIRED scalar-array long[]   (StrictArg long .Value unwrap)
    //   • weights : REQUIRED scalar-array double[]   (StrictArg double .Value unwrap)
    //   • flagsArr: REQUIRED scalar-array bool[]   (StrictArg bool .Value unwrap)
    //   • priority: REQUIRED enum (strict-map `m.priority!` run-proof)
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
        { "field.int":    { "name": "scores", "isArray": true, "@required": true } },
        { "field.long":   { "name": "quantities", "isArray": true, "@required": true } },
        { "field.double": { "name": "weights", "isArray": true, "@required": true } },
        { "field.boolean":{ "name": "flagsArr", "isArray": true, "@required": true } },
        { "field.enum":   { "name": "priority", "@required": true, "@values": ["LOW", "HIGH"] } },
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
    public void Extractor_emits_extract_extractLenient_and_recursive_mappers()
    {
        var src = Assert.Single(new ExtractorGenerator().Generate(Ctx(Load(Model)))).Content;

        // Extractor class named off the strict payload type.
        Assert.Contains("public static class OrderExtractor", src);

        // extract(MetaObject, text) returns the STRICT record + the opts overload.
        Assert.Contains("public static Order Extract(", src);
        Assert.Contains("global::MetaObjects.Meta.MetaObject mo, string text)", src);
        Assert.Contains("ExtractOptions opts", src);

        // routes through the NESTED-CAPABLE delegating extract (NOT the self-contained ExtractLenient(string)).
        Assert.Contains("OrderOutParser.ExtractLenient(mo, text", src);

        // throws ExtractException on lost-required.
        Assert.Contains("HasLostRequired()", src);
        Assert.Contains("throw new ExtractException(", src);

        // re-exposes the lenient extract (returns the mirror result).
        Assert.Contains("ExtractionResult<OrderExtracted> ExtractLenient(", src);

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
            "  \"scores\": [3, 7]," +
            "  \"quantities\": [10, 9000000000]," +
            "  \"weights\": [1.5, 2.25]," +
            "  \"flagsArr\": [true, false, true]," +
            "  \"priority\": \"HIGH\"," +
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

        // required NON-STRING scalar-array (int[]) populates as IReadOnlyList<int> — proves the
        // kind-typed mirror element (IReadOnlyList<int?>?) narrows to the strict int element.
        var scoresProp = order.GetType().GetProperty("scores")!;
        Assert.Equal(typeof(IReadOnlyList<int>), scoresProp.PropertyType);
        var scores = ((IEnumerable)scoresProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 3, 7 }, scores.ToArray());

        // required NON-STRING scalar-array (long[]) — proves the StrictArg `x!.Value` long unwrap
        // narrows the kind-typed mirror (IReadOnlyList<long?>?) to the strict long element. The
        // CS8619-as-error compile gate would have failed had the element type mismatched.
        var quantitiesProp = order.GetType().GetProperty("quantities")!;
        Assert.Equal(typeof(IReadOnlyList<long>), quantitiesProp.PropertyType);
        var quantities = ((IEnumerable)quantitiesProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 10L, 9000000000L }, quantities.ToArray());
        Assert.IsType<long>(quantities[0]);

        // required NON-STRING scalar-array (double[]) — proves the double `x!.Value` unwrap.
        var weightsProp = order.GetType().GetProperty("weights")!;
        Assert.Equal(typeof(IReadOnlyList<double>), weightsProp.PropertyType);
        var weights = ((IEnumerable)weightsProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 1.5d, 2.25d }, weights.ToArray());
        Assert.IsType<double>(weights[0]);

        // required NON-STRING scalar-array (bool[]) — proves the bool `x!.Value` unwrap.
        var flagsProp = order.GetType().GetProperty("flagsArr")!;
        Assert.Equal(typeof(IReadOnlyList<bool>), flagsProp.PropertyType);
        var flags = ((IEnumerable)flagsProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { true, false, true }, flags.ToArray());
        Assert.IsType<bool>(flags[0]);

        // required ENUM through the strict tier — the StrictArg enum branch (`m.priority!`,
        // string-backed) populates the strict record from dirty input. NOTE the strict property
        // type is `object` (not `string`): PayloadCodegen's scalar map has no enum entry, so an enum
        // field falls through to the `object` default — but the value is the string-backed member.
        var priorityProp = order.GetType().GetProperty("priority")!;
        Assert.Equal(typeof(object), priorityProp.PropertyType);
        Assert.Equal("HIGH", priorityProp.GetValue(order));

        // non-@required single nested, present -> populates.
        var shipTo = order.GetType().GetProperty("shipTo")!.GetValue(order)!;
        Assert.Equal("Grace", shipTo.GetType().GetProperty("name")!.GetValue(shipTo));
    }

    [Fact]
    public void Generated_extract_opts_overload_populates_same_strict_graph()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderExtractor")!;
        var optsType = typeof(MetaObjects.Render.Extract.ExtractOptions);

        // The 3-arg overload: Extract(MetaObject, string, ExtractOptions).
        var extractWithOpts = extractorType.GetMethod("Extract",
            new[] { typeof(MetaObject), typeof(string), optsType })!;
        Assert.NotNull(extractWithOpts);

        MetaObject orderMo = root.FindObject("Order")!;

        // NOTE: shipTo is included because PayloadCodegen types EVERY field (even non-@required ones)
        // as `required` non-nullable, so the strict mapper maps shipTo as required — omitting it would
        // pass null to ToStrict_Customer (the documented C#-specific optionality, see the file header).
        const string dirty =
            "Here:\n```json\n" +
            "{ \"orderId\": \"A-200\"," +
            "  \"customer\": { \"name\": \"Ada\" }," +
            "  \"lines\": [ { \"sku\": \"A\", \"qty\": 3 } ]," +
            "  \"tags\": [\"x\"]," +
            "  \"scores\": [9]," +
            "  \"quantities\": [42]," +
            "  \"weights\": [3.5]," +
            "  \"flagsArr\": [false]," +
            "  \"priority\": \"HIGH\"," +
            "  \"shipTo\": { \"name\": \"Grace\" } }\n```";

        var opts = optsType.GetMethod("Defaults")!.Invoke(null, null);
        var order = extractWithOpts.Invoke(null, new object?[] { orderMo, dirty, opts })!;

        // Same populated strict graph as the 2-arg path, via the opts overload.
        Assert.Equal("A-200", order.GetType().GetProperty("orderId")!.GetValue(order));
        var customer = order.GetType().GetProperty("customer")!.GetValue(order)!;
        Assert.Equal("Ada", customer.GetType().GetProperty("name")!.GetValue(customer));

        var quantities = ((IEnumerable)order.GetType().GetProperty("quantities")!.GetValue(order)!)
            .Cast<object>().ToList();
        Assert.Equal(new object[] { 42L }, quantities.ToArray());
        Assert.Equal("HIGH", order.GetType().GetProperty("priority")!.GetValue(order));
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
        Assert.IsType<MetaObjects.Render.Extract.ExtractException>(ex.InnerException);
    }

    [Fact]
    public void Re_exposed_extract_never_throws_on_clean_input()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderExtractor")!;
        var extractLenient = extractorType.GetMethod("ExtractLenient", new[] { typeof(MetaObject), typeof(string) })!;
        MetaObject orderMo = root.FindObject("Order")!;

        const string clean =
            "{ \"orderId\": \"A-7\", \"customer\": { \"name\": \"Ada\" }," +
            "  \"lines\": [ { \"sku\": \"A\", \"qty\": 1 } ], \"tags\": [\"a\"], \"scores\": [1]," +
            "  \"quantities\": [1], \"weights\": [1.0], \"flagsArr\": [true], \"priority\": \"LOW\" }";

        var result = extractLenient.Invoke(null, new object?[] { orderMo, clean })!;
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
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));

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
