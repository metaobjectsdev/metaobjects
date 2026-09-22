// Cross-port Extractor codegen (Task 3, C#) — the compile-AND-RUN proof for the `extract` tier.
//
// The Extractor sits OVER the existing nested-capable runtime-delegating extract
// (<Name>OutputParser.ExtractLenient(MetaObject, text)) and turns dirty LLM text into the value
// object's own POCO (ADR-0056 — EntityGenerator's, never a template-tier copy) in one call: run
// extract, throw ExtractException iff a @required field was lost, else map the all-nullable
// <Name>Extracted mirror onto the POCO via a generated recursive mirror->POCO mapper (recurse
// nested objects + arrays-of-objects; one object-initializer construct). extract is re-exposed
// unchanged. NO registry / binding / factory.
//
// Optionality follows @required, as the POCO does: a required member maps with `!` (the
// lost-required gate guarantees it is present), an optional one maps an absent value to null.

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
    //   • priority: REQUIRED enum -> nested enum OrderPriority (Enum.Parse strict-map run-proof)
    //   • labels  : REQUIRED enum ARRAY -> IReadOnlyList<OrderLabels> (per-element Enum.Parse)
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
        { "field.enum":   { "name": "labels", "isArray": true, "@required": true, "@values": ["A", "B"] } },
        { "field.string": { "name": "note" } },
        { "field.object": { "name": "shipTo", "@objectRef": "Customer" } }
      ]}},
      { "template.prompt": { "name": "OrderOut", "@payloadRef": "Order", "@responseRef": "Order",
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
    public void Extractor_emits_extract_extractLenient_and_recursive_mappers()
    {
        var src = Assert.Single(new ExtractorGenerator().Generate(Ctx(Load(Model)))).Content;

        // Extractor class named off the prompt, like its parser (ADR-0056 rule 4).
        Assert.Contains("public static class OrderOutExtractor", src);

        // extract(MetaObject, text) returns the value object's POCO + the opts overload.
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

        // scalar-array drops nulls (mirror IReadOnlyList<string?>? -> POCO ICollection<string>).
        Assert.Contains(".Where(", src);
        // object-array maps element-wise via the element mapper.
        Assert.Contains("Select(x => ToStrict_Line(x!))", src);
        // an optional member maps null to null instead of dereferencing it.
        Assert.Contains("m.shipTo is null ? null : ToStrict_Customer(m.shipTo)", src);
        Assert.Contains("Qty = m.qty,", src);
    }

    // ---- compile-AND-run proof ----

    [Fact]
    public void Generated_extract_populates_strict_graph_from_dirty_text()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderOutExtractor")!;
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
            "  \"labels\": [\"A\", \"B\"]," +
            "  \"shipTo\": { \"name\": \"Grace\" }, }\n```";

        var order = extract.Invoke(null, new object?[] { orderMo, dirty })!;

        Assert.Equal("A-100", order.GetType().GetProperty("OrderId")!.GetValue(order));

        // required single nested populates + is the strict element type.
        var customer = order.GetType().GetProperty("Customer")!.GetValue(order)!;
        Assert.Equal("Customer", customer.GetType().Name);
        Assert.Equal("Ada", customer.GetType().GetProperty("Name")!.GetValue(customer));

        // required array-of-objects populates, each element strict + populated.
        var lines = ((IEnumerable)order.GetType().GetProperty("Lines")!.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(2, lines.Count);
        Assert.Equal("A", lines[0].GetType().GetProperty("Sku")!.GetValue(lines[0]));
        Assert.Equal(2, lines[0].GetType().GetProperty("Qty")!.GetValue(lines[0]));

        // required scalar-array populates with NO null elements (drop-null projection).
        var tags = ((IEnumerable)order.GetType().GetProperty("Tags")!.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { "x", "y" }, tags.ToArray());

        // required NON-STRING scalar-array (int[]) populates as ICollection<int> — proves the
        // kind-typed mirror element (IReadOnlyList<int?>?) narrows to the strict int element.
        var scoresProp = order.GetType().GetProperty("Scores")!;
        Assert.Equal(typeof(ICollection<int>), scoresProp.PropertyType);
        var scores = ((IEnumerable)scoresProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 3, 7 }, scores.ToArray());

        // required NON-STRING scalar-array (long[]) — proves the StrictArg `x!.Value` long unwrap
        // narrows the kind-typed mirror (IReadOnlyList<long?>?) to the strict long element. The
        // CS8619-as-error compile gate would have failed had the element type mismatched.
        var quantitiesProp = order.GetType().GetProperty("Quantities")!;
        Assert.Equal(typeof(ICollection<long>), quantitiesProp.PropertyType);
        var quantities = ((IEnumerable)quantitiesProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 10L, 9000000000L }, quantities.ToArray());
        Assert.IsType<long>(quantities[0]);

        // required NON-STRING scalar-array (double[]) — proves the double `x!.Value` unwrap.
        var weightsProp = order.GetType().GetProperty("Weights")!;
        Assert.Equal(typeof(ICollection<double>), weightsProp.PropertyType);
        var weights = ((IEnumerable)weightsProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { 1.5d, 2.25d }, weights.ToArray());
        Assert.IsType<double>(weights[0]);

        // required NON-STRING scalar-array (bool[]) — proves the bool `x!.Value` unwrap.
        var flagsProp = order.GetType().GetProperty("FlagsArr")!;
        Assert.Equal(typeof(ICollection<bool>), flagsProp.PropertyType);
        var flags = ((IEnumerable)flagsProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[] { true, false, true }, flags.ToArray());
        Assert.IsType<bool>(flags[0]);

        // required ENUM through the strict tier — the StrictArg enum branch
        // (`System.Enum.Parse<OrderPriority>(m.priority!)`) coerces the string-backed mirror member
        // into the generated NESTED enum type. The strict property type is the nested enum
        // (Order.OrderPriority), NOT `object` and NOT `string`.
        var priorityProp = order.GetType().GetProperty("Priority")!;
        Assert.True(priorityProp.PropertyType.IsEnum, "priority should be a nested enum type, not object/string");
        Assert.Equal("OrderPriority", priorityProp.PropertyType.Name);
        var priorityVal = priorityProp.GetValue(order)!;
        Assert.Equal("HIGH", priorityVal.ToString());
        Assert.Equal(System.Enum.Parse(priorityProp.PropertyType, "HIGH"), priorityVal);

        // required ENUM ARRAY -> IReadOnlyList<OrderLabels> (element type IsEnum), per-element
        // Enum.Parse from the string-backed mirror list. Proves the enum-array routes through the
        // string-LIST reader (not the scalar enum reader) and each element coerces to the nested enum.
        var labelsProp = order.GetType().GetProperty("Labels")!;
        Assert.True(typeof(IEnumerable).IsAssignableFrom(labelsProp.PropertyType));
        var labelsElemType = labelsProp.PropertyType.GetGenericArguments().Single();
        Assert.True(labelsElemType.IsEnum, "labels element should be a nested enum type");
        Assert.Equal("OrderLabels", labelsElemType.Name);
        Assert.Equal(new[] { "A", "B" }, labelsElemType.GetEnumNames());
        var labels = ((IEnumerable)labelsProp.GetValue(order)!).Cast<object>().ToList();
        Assert.Equal(new object[]
        {
            System.Enum.Parse(labelsElemType, "A"),
            System.Enum.Parse(labelsElemType, "B"),
        }, labels.ToArray());

        // non-@required single nested, present -> populates.
        var shipTo = order.GetType().GetProperty("ShipTo")!.GetValue(order)!;
        Assert.Equal("Grace", shipTo.GetType().GetProperty("Name")!.GetValue(shipTo));
    }

    [Fact]
    public void Generated_extract_opts_overload_populates_same_strict_graph()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderOutExtractor")!;
        var optsType = typeof(MetaObjects.Render.Extract.ExtractOptions);

        // The 3-arg overload: Extract(MetaObject, string, ExtractOptions).
        var extractWithOpts = extractorType.GetMethod("Extract",
            new[] { typeof(MetaObject), typeof(string), optsType })!;
        Assert.NotNull(extractWithOpts);

        MetaObject orderMo = root.FindObject("Order")!;

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
            "  \"labels\": [\"B\"]," +
            "  \"shipTo\": { \"name\": \"Grace\" } }\n```";

        var opts = optsType.GetMethod("Defaults")!.Invoke(null, null);
        var order = extractWithOpts.Invoke(null, new object?[] { orderMo, dirty, opts })!;

        // Same populated strict graph as the 2-arg path, via the opts overload.
        Assert.Equal("A-200", order.GetType().GetProperty("OrderId")!.GetValue(order));
        var customer = order.GetType().GetProperty("Customer")!.GetValue(order)!;
        Assert.Equal("Ada", customer.GetType().GetProperty("Name")!.GetValue(customer));

        var quantities = ((IEnumerable)order.GetType().GetProperty("Quantities")!.GetValue(order)!)
            .Cast<object>().ToList();
        Assert.Equal(new object[] { 42L }, quantities.ToArray());
        var priorityProp = order.GetType().GetProperty("Priority")!;
        Assert.True(priorityProp.PropertyType.IsEnum);
        Assert.Equal("HIGH", priorityProp.GetValue(order)!.ToString());
    }

    [Fact]
    public void Generated_extract_leaves_absent_optional_members_null()
    {
        // `shipTo` (object) and each line's `qty` (int) carry no @required. Absent from the reply,
        // they map to null — they used to be dereferenced (`m.qty!.Value`) and throw.
        var root = Load(Model);
        var asm = Compile(root);
        var extract = asm.GetType("Acme.Generated.OrderOutExtractor")!
            .GetMethod("Extract", new[] { typeof(MetaObject), typeof(string) })!;

        const string reply =
            "{ \"orderId\": \"A-9\", \"customer\": { \"name\": \"Ada\" }, \"lines\": [ { \"sku\": \"A\" } ]," +
            "  \"tags\": [], \"scores\": [], \"quantities\": [], \"weights\": [], \"flagsArr\": []," +
            "  \"priority\": \"LOW\", \"labels\": [] }";
        var order = extract.Invoke(null, new object?[] { root.FindObject("Order")!, reply })!;

        Assert.Null(order.GetType().GetProperty("ShipTo")!.GetValue(order));
        var line = ((IEnumerable)order.GetType().GetProperty("Lines")!.GetValue(order)!).Cast<object>().Single();
        Assert.Null(line.GetType().GetProperty("Qty")!.GetValue(line));
    }

    [Fact]
    public void Generated_extract_throws_on_lost_required()
    {
        var root = Load(Model);
        var asm = Compile(root);

        var extractorType = asm.GetType("Acme.Generated.OrderOutExtractor")!;
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

        var extractorType = asm.GetType("Acme.Generated.OrderOutExtractor")!;
        var extractLenient = extractorType.GetMethod("ExtractLenient", new[] { typeof(MetaObject), typeof(string) })!;
        MetaObject orderMo = root.FindObject("Order")!;

        const string clean =
            "{ \"orderId\": \"A-7\", \"customer\": { \"name\": \"Ada\" }," +
            "  \"lines\": [ { \"sku\": \"A\", \"qty\": 1 } ], \"tags\": [\"a\"], \"scores\": [1]," +
            "  \"quantities\": [1], \"weights\": [1.0], \"flagsArr\": [true], \"priority\": \"LOW\"," +
            "  \"labels\": [\"A\"] }";

        var result = extractLenient.Invoke(null, new object?[] { orderMo, clean })!;
        var report = result.GetType().GetProperty("Report")!.GetValue(result)!;
        Assert.False((bool)report.GetType().GetMethod("HasLostRequired")!.Invoke(report, null)!);
    }

    // ---- nested-enum-typed payload: POCO typing + lenient mirror stays string ----

    [Fact]
    public void Poco_types_enum_as_nested_enum_lenient_mirror_stays_string()
    {
        var root = Load(Model);

        // The POCO (EntityGenerator): enum scalar -> nested enum type; enum array -> a collection of it.
        var poco = Assert.Single(new EntityGenerator().Generate(Ctx(root)), f => f.Path == "Order.g.cs").Content;
        Assert.Contains("public enum OrderPriority { LOW, HIGH }", poco);
        Assert.Contains("public enum OrderLabels { A, B }", poco);
        Assert.Contains("public OrderPriority Priority { get; set; }", poco);
        Assert.Contains("public ICollection<OrderLabels> Labels { get; set; } = new List<OrderLabels>();", poco);

        // The extract mapper coerces the string mirror via System.Enum.Parse<NestedEnum>.
        var extractorSrc = Assert.Single(new ExtractorGenerator().Generate(Ctx(root))).Content;
        Assert.Contains("System.Enum.Parse<Order.OrderPriority>(m.priority!)", extractorSrc);
        Assert.Contains("System.Enum.Parse<Order.OrderLabels>(", extractorSrc);

        // LENIENT mirror: the enum leaf stays string-backed (scalar string?, array string list).
        var mirror = Assert.Single(new OutputParserGenerator().Generate(Ctx(root)), f => f.Path == "OrderExtracted.g.cs").Content;
        Assert.Contains("string? priority { get; init; }", mirror);
        Assert.Contains("IReadOnlyList<string?>? labels { get; init; }", mirror);
        // No nested enum type bleeds into the lenient mirror.
        Assert.DoesNotContain("OrderPriority", mirror);
        Assert.DoesNotContain("OrderLabels", mirror);
    }

    // ---- shared-enum proof: one abstract enum, two extending fields, ONE decl ----

    private const string SharedEnumModel = """
    { "metadata.root": { "package": "acme::orders", "children": [
      { "field.enum": { "name": "Priority", "abstract": true, "@values": ["LOW", "HIGH"] } },
      { "object.value": { "name": "Ticket", "children": [
        { "field.string": { "name": "ticketId", "@required": true } },
        { "field.enum":   { "name": "currentPriority",  "@required": true, "extends": "Priority" } },
        { "field.enum":   { "name": "previousPriority", "@required": true, "extends": "Priority" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Shared_abstract_enum_emits_one_enum_both_fields_typed_by_super()
    {
        var root = Load(SharedEnumModel);
        var all = string.Concat(new EntityGenerator().Generate(Ctx(root)).Select(f => f.Content));

        // Exactly ONE enum declaration (FR-019's shared-enums file), named for the super.
        int enumDeclCount = System.Text.RegularExpressions.Regex.Matches(all, @"public enum Priority \{").Count;
        Assert.True(enumDeclCount == 1, $"expected exactly one enum Priority, got {enumDeclCount}");

        // BOTH fields typed by the shared enum.
        Assert.Contains("public Priority CurrentPriority { get; set; }", all);
        Assert.Contains("public Priority PreviousPriority { get; set; }", all);
    }

    private static Assembly Compile(MetaRoot root)
    {
        var ctx = Ctx(root);
        // The parser + its mirrors, the extractor, and the value objects' own POCOs (ADR-0056).
        var sources = new OutputParserGenerator().Generate(ctx).Select(f => f.Content)
            .Append(Assert.Single(new ExtractorGenerator().Generate(ctx)).Content)
            .Concat(GeneratedValueObjects.Sources(root));

        var trees = sources
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
