// Fr015CodegenTests — FR-015 @parameterRef callable-wrapper C# codegen emission.
//
// A source.rdb @kind:"storedProc" | "tableFunction" entity gets a generated calling
// method (one <Entity>.callable.cs per callable entity). Per the FR-015 spec, the C#
// emission uses EF Core FromSqlInterpolated:
//
//   public static Task<IReadOnlyList<PhaseSummary>> Call(AppDbContext db, PhaseSummaryArgs args)
//       => db.Set<PhaseSummary>()
//             .FromSqlInterpolated($"SELECT * FROM analytics.fn_phase_summary({args.CaseId}, {args.AsOfDate})")
//             .ToListAsync()...;
//
// Args bind in the @parameterRef value-object's field DECLARATION order. A callable
// with no @parameterRef emits a zero-arg overload calling fn_x().
//
// Mirrors the TS reference (codegen-ts templates/callable-file.ts), which emits one
// call<Entity>(db, args) per callable with the same SQL arg-order contract.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Fr015CodegenTests
{
    // One value-object (the proc args, two fields in declaration order), a storedProc
    // entity referencing it via @parameterRef, a tableFunction entity, and a zero-arg
    // storedProc entity (no @parameterRef).
    private const string Model = """
    { "metadata.root": { "package": "acme::analytics", "children": [
      { "object.value": { "name": "PhaseSummaryArgs", "children": [
        { "field.int":       { "name": "caseId", "@required": true } },
        { "field.timestamp": { "name": "asOfDate" } }
      ]}},
      { "object.projection": { "name": "PhaseSummary", "children": [
        { "source.rdb":  { "@kind": "storedProc", "@proc": "fn_phase_summary", "@schema": "analytics", "@parameterRef": "PhaseSummaryArgs" } },
        { "field.long":   { "name": "phaseId" } },
        { "field.string": { "name": "phaseName" } }
      ]}},
      { "object.projection": { "name": "ActivePhases", "children": [
        { "source.rdb":  { "@kind": "tableFunction", "@function": "fn_active_phases", "@parameterRef": "PhaseSummaryArgs" } },
        { "field.long":   { "name": "phaseId" } }
      ]}},
      { "object.projection": { "name": "AllPhases", "children": [
        { "source.rdb":  { "@kind": "storedProc", "@proc": "fn_all_phases" } },
        { "field.long":   { "name": "phaseId" } }
      ]}},
      { "object.entity": { "name": "Plain", "children": [
        { "source.rdb":  { "@table": "plains" } },
        { "field.long":   { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
    };

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "fr015.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static IReadOnlyList<EmittedFile> Files()
        => new CallableGenerator().Generate(Ctx(Load())).ToList();

    private static string Content(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    [Fact]
    public void Source_ParameterRef_and_IsCallable_reflect_attrs()
    {
        var root = Load();
        var ps = root.FindObject("PhaseSummary")!.Sources()[0];
        Assert.True(ps.IsCallable());
        Assert.Equal("PhaseSummaryArgs", ps.ParameterRef);

        var plain = root.FindObject("Plain")!.Sources()[0];
        Assert.False(plain.IsCallable());
        Assert.Null(plain.ParameterRef);
    }

    [Fact]
    public void Only_callable_entities_emit_a_callable_file()
    {
        var files = Files();
        var paths = files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToList();
        Assert.Equal(
            ["ActivePhases.callable.g.cs", "AllPhases.callable.g.cs", "PhaseSummary.callable.g.cs"],
            paths);
    }

    [Fact]
    public void StoredProc_with_parameterRef_emits_FromSqlInterpolated_in_declaration_order()
    {
        var c = Content(Files(), "PhaseSummary.callable.g.cs");

        // Method signature: db + the args value-object.
        Assert.Contains("AppDbContext db, PhaseSummaryArgs args", c);
        // Returns the projection rows.
        Assert.Contains("Task<IReadOnlyList<PhaseSummary>>", c);
        // FromSqlInterpolated with schema-qualified proc name + args in declaration
        // order (caseId, asOfDate → CaseId, AsOfDate).
        Assert.Contains(
            "FromSqlInterpolated($\"SELECT * FROM analytics.fn_phase_summary({args.CaseId}, {args.AsOfDate})\")",
            c);
        Assert.Contains("db.Set<PhaseSummary>()", c);
        Assert.Contains("ToListAsync", c);
    }

    [Fact]
    public void TableFunction_with_parameterRef_emits_unqualified_proc_name()
    {
        var c = Content(Files(), "ActivePhases.callable.g.cs");
        // No @schema → bare function name.
        Assert.Contains(
            "FromSqlInterpolated($\"SELECT * FROM fn_active_phases({args.CaseId}, {args.AsOfDate})\")",
            c);
        Assert.Contains("AppDbContext db, PhaseSummaryArgs args", c);
    }

    [Fact]
    public void ZeroArg_callable_emits_no_args_method()
    {
        var c = Content(Files(), "AllPhases.callable.g.cs");
        // No args parameter.
        Assert.Contains("AppDbContext db)", c);
        Assert.DoesNotContain("args", c);
        // Empty parameter list in the SQL.
        Assert.Contains("FromSqlInterpolated($\"SELECT * FROM fn_all_phases()\")", c);
        Assert.Contains("Task<IReadOnlyList<AllPhases>>", c);
    }

    [Fact]
    public void Registry_exposes_callable_for_csharp()
    {
        Assert.True(GeneratorRegistry.Entries.ContainsKey("callable"));
        var built = GeneratorRegistry.Resolve(["callable"]);
        Assert.Single(built);
        Assert.IsType<CallableGenerator>(built[0]);
    }
}
