// FR-010 — the runtime-DELEGATING extract mirror and its Dlg* readers must agree on the C#
// type of EVERY scalar field kind, for single scalars AND for scalar arrays.
//
// Fr010FieldMapping.ScalarMirrorType's doc-comment claims the self-contained mirror, the
// delegating mirror and the scalar-array element type stay "in lock-step". Nothing tested that
// claim, and the delegating side drifted: ScalarReader had no "Decimal" branch, so a
// `field.decimal` reached through a nested object typed as `decimal?` in the mirror
// (ExtractDelegateEmitter.NestedMirrorType -> ScalarMirrorType) but was assigned from
// DlgString -> `error CS0029: Cannot implicitly convert type 'string' to 'decimal?'`.
//
// It only reproduces on the DELEGATING path, which is used for fields reached through a nested
// object or an array-of-objects — a flat top-level payload goes through the self-contained path
// (ExtractMapCall), which always had its Decimal branch. Hence: nest the fields.
//
// These are compile proofs, driven off FieldConstants.FIELD_SUBTYPES, so a newly registered
// scalar subtype joins the gate automatically instead of silently taking the DlgString default.

using System.Collections;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Tests;

public sealed class Fr010DelegatingMirrorLockStepTests
{
    /// <summary>
    /// Every scalar field subtype: everything in FIELD_SUBTYPES minus the abstract base and the
    /// two structural subtypes (object/map) that are not scalars. Read from the constant so a
    /// newly registered subtype is covered without editing this test.
    /// </summary>
    public static IEnumerable<string> ScalarSubTypes() => FIELD_SUBTYPES.Where(st =>
        st != MetaObjects.Shared.BaseTypes.SUBTYPE_BASE &&
        st != FIELD_SUBTYPE_OBJECT &&
        st != FIELD_SUBTYPE_MAP);

    public static TheoryData<string> ScalarSubTypeCases()
    {
        var data = new TheoryData<string>();
        foreach (var st in ScalarSubTypes()) data.Add(st);
        return data;
    }

    /// <summary>
    /// A model whose payload reaches `field.&lt;subType&gt;` through BOTH a nested object and an
    /// array-of-objects, so the delegating mapper must emit a reader for it in both the single
    /// and the scalar-array position.
    /// </summary>
    private static string NestedScalarModel(string subType, bool isArray)
    {
        var arr = isArray ? ", \"isArray\": true" : "";
        // field.enum needs its @values; nothing else takes a required attr.
        var extra = subType == FIELD_SUBTYPE_ENUM ? ", \"@values\": [\"A\",\"B\"]" : "";
        var model = """
        { "metadata.root": { "package": "acme::probe", "children": [
          { "object.value": { "name": "Inner", "children": [
            { "field.__ST__": { "name": "v"__ARR____EXTRA__ } }
          ]}},
          { "object.value": { "name": "Probe", "children": [
            { "field.string": { "name": "id", "@required": true } },
            { "field.object": { "name": "single", "@objectRef": "Inner" } },
            { "field.object": { "name": "many", "isArray": true, "@objectRef": "Inner" } }
          ]}},
          { "template.prompt": { "name": "Probe", "@payloadRef": "Probe", "@responseRef": "Probe",
              "@textRef": "ai/probe", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } }
        ]}}
        """;
        return model.Replace("__ST__", subType).Replace("__ARR__", arr).Replace("__EXTRA__", extra);
    }

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "probe.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // ---- the lock-step compile gate, per scalar subtype ----

    [Theory]
    [MemberData(nameof(ScalarSubTypeCases))]
    public void Delegating_mirror_and_reader_agree_for_every_single_scalar_subtype(string subType)
    {
        AssertGeneratedCompiles(subType, isArray: false);
    }

    [Theory]
    [MemberData(nameof(ScalarSubTypeCases))]
    public void Delegating_mirror_and_reader_agree_for_every_scalar_array_subtype(string subType)
    {
        AssertGeneratedCompiles(subType, isArray: true);
    }

    // ---- the specific #NNN regression: a nested decimal ----

    [Fact]
    public void Nested_decimal_reads_through_DlgDecimal_not_DlgString()
    {
        var src = Assert.Single(
            new OutputParserGenerator().Generate(Ctx(Load(NestedScalarModel(FIELD_SUBTYPE_DECIMAL, false))))).Content;

        // The mirror types it decimal? ...
        Assert.Contains("public decimal? v { get; init; }", src);
        // ... so the reader must be the decimal one, and the helper must exist.
        Assert.Contains("v = DlgDecimal(ReadProp(o, \"v\")),", src);
        Assert.Contains("private static decimal? DlgDecimal(object? v)", src);
        Assert.DoesNotContain("v = DlgString(ReadProp(o, \"v\")),", src);
    }

    [Fact]
    public void Nested_decimal_array_reads_through_DlgDecimal_elements()
    {
        var src = Assert.Single(
            new OutputParserGenerator().Generate(Ctx(Load(NestedScalarModel(FIELD_SUBTYPE_DECIMAL, true))))).Content;

        // NestedMirrorType kind-types array elements via ScalarMirrorType (NOT
        // ScalarArrayElementType, which is the SELF-CONTAINED mirror's rule), so the
        // delegating element reader has to be DlgDecimal too.
        Assert.Contains("global::System.Collections.Generic.IReadOnlyList<decimal?>? v { get; init; }", src);
        Assert.Contains("v = DlgList(ReadProp(o, \"v\"), DlgDecimal),", src);
    }

    // ---- run proof: a nested decimal actually round-trips ----

    [Fact]
    public void Generated_delegating_extract_populates_nested_decimals()
    {
        var root = Load(NestedScalarModel(FIELD_SUBTYPE_DECIMAL, false));
        var asm = Compile(root);

        var parserType = asm.GetType("Acme.Generated.ProbeParser")!;
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaObject), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;

        const string dirty =
            "```json\n{ \"id\": \"P-1\", \"single\": { \"v\": 12.345 }, " +
            "\"many\": [ { \"v\": 0.5 }, { \"v\": 7 } ] }\n```";

        var result = extract.Invoke(null, new object?[] { root.FindObject("Probe")!, dirty, null })!;
        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;

        var single = data.GetType().GetProperty("single")!.GetValue(data);
        Assert.NotNull(single);
        Assert.Equal(12.345m, single!.GetType().GetProperty("v")!.GetValue(single));

        var many = ((IEnumerable)data.GetType().GetProperty("many")!.GetValue(data)!).Cast<object>().ToList();
        Assert.Equal(2, many.Count);
        Assert.Equal(0.5m, many[0].GetType().GetProperty("v")!.GetValue(many[0]));
        Assert.Equal(7m, many[1].GetType().GetProperty("v")!.GetValue(many[1]));
    }

    [Fact]
    public void Generated_delegating_extract_populates_a_nested_decimal_ARRAY()
    {
        // The compile gates above prove a decimal ARRAY emits code that builds. They do not
        // prove the VALUES arrive: DlgList(..., DlgDecimal) could return an empty list, or
        // round every element through a double, and still compile. Java cannot do this at all
        // (its object model has no DECIMAL_ARRAY conversion, so the component is dropped), so
        // whether C# genuinely supports the shape is a fact worth pinning rather than assuming.
        var root = Load(NestedScalarModel(FIELD_SUBTYPE_DECIMAL, true));
        var asm = Compile(root);

        var parserType = asm.GetType("Acme.Generated.ProbeParser")!;
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaObject), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;

        const string dirty = "```json\n{ \"id\": \"A-1\", \"single\": { \"v\": [1.25, 2.5, 7] } }\n```";

        var result = extract.Invoke(null, new object?[] { root.FindObject("Probe")!, dirty, null })!;
        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;

        var single = data.GetType().GetProperty("single")!.GetValue(data);
        Assert.NotNull(single);
        var v = (IEnumerable)single!.GetType().GetProperty("v")!.GetValue(single)!;
        var elems = v.Cast<object?>().ToList();

        Assert.Equal(3, elems.Count);
        // decimal?, element-typed — NOT string, and precision preserved.
        Assert.Equal(1.25m, elems[0]);
        Assert.Equal(2.5m, elems[1]);
        Assert.Equal(7m, elems[2]);
    }

    // ---- harness ----

    private static void AssertGeneratedCompiles(string subType, bool isArray)
    {
        Compile(Load(NestedScalarModel(subType, isArray)));
    }

    private static Assembly Compile(MetaRoot root)
    {
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n"
                       + PayloadCodegen.GeneratePayloadRecords(root, "Probe");

        var trees = new[] { parserSrc, payloadSrc }.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            .WithSpecificDiagnosticOptions(new Dictionary<string, ReportDiagnostic>
            {
                ["CS8619"] = ReportDiagnostic.Error,
            });
        var comp = CSharpCompilation.Create("fr010lockstep_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0,
            "generated delegating extract should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
