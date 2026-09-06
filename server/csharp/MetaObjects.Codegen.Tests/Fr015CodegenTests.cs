// Fr015CodegenTests — FR-015 @parameterRef callable-wrapper C# codegen emission.
//
// A source.rdb @kind:"storedProc" | "tableFunction" entity gets a generated calling
// method (one <Entity>.callable.cs per callable entity). Per the FR-015 spec, the C#
// emission uses EF Core FromSqlInterpolated when the names artifact is NOT in the run:
//
//   public static Task<IReadOnlyList<PhaseSummary>> Call(AppDbContext db, PhaseSummaryArgs args)
//       => db.Set<PhaseSummary>()
//             .FromSqlInterpolated($"SELECT * FROM analytics.fn_phase_summary({args.CaseId}, {args.AsOfDate})")
//             .ToListAsync()...;
//
// and, when it IS (the default suite — §A6 / no-magic-physical-names), references the
// procedure's name through FromSqlRaw, because an interpolation hole is a PARAMETER and an
// identifier cannot be one:
//
//             .FromSqlRaw("SELECT * FROM " + PhaseSummaryNames.SourcePrimarySchema + "." + PhaseSummaryNames.SourcePrimaryProc + "({0}, {1})", args.CaseId, args.AsOfDate)
//
// Args bind in the @parameterRef value-object's field DECLARATION order on both arms. A
// callable with no @parameterRef emits a zero-arg overload calling fn_x().
//
// Mirrors the TS reference (codegen-ts templates/callable-file.ts), which emits one
// call<Entity>(db, args) per callable with the same SQL arg-order contract (and splices the
// constant through drizzle's `sql.raw` for the same reason).

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
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

    // ---------------------------------------------------------------------------------
    // The names-ON arm (§A6 / no-magic-physical-names): the procedure's physical name is
    // REFERENCED from <Entity>Names rather than spelled a second time. The emitted FORM is
    // the point of these tests: a FromSqlInterpolated hole binds a PARAMETER, and an
    // identifier cannot be one, so the constant is spliced into a FromSqlRaw string with
    // `{n}` placeholders for the arguments — the C# analogue of the drizzle `sql.raw` the TS
    // reference uses. The tests above run the OFF arm (GenConfig.IncludeNames defaults to
    // false) and pin it byte-identical to what this generator always emitted.
    // ---------------------------------------------------------------------------------
    private static GenContext NamesCtx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal, IncludeNames = true },
    };

    private static IReadOnlyList<EmittedFile> NamesOnFiles()
        => new CallableGenerator().Generate(NamesCtx(Load())).ToList();

    [Fact]
    public void NamesOn_references_the_constant_through_FromSqlRaw_including_the_schema()
    {
        var c = Content(NamesOnFiles(), "PhaseSummary.callable.g.cs");
        // The identifier is text; each argument is a `{n}` placeholder → a DbParameter.
        // BOTH halves of the qualified name are constants now. The schema used to stay a
        // spelled literal here while the artifact's schema constant sat unread, justified by "schema
        // qualification is ruled on separately across the ports" — it has been ruled on, every
        // port qualifies, and this was the one C# site that qualified at all.
        Assert.Contains(
            ".FromSqlRaw(\"SELECT * FROM \" + PhaseSummaryNames.SourcePrimarySchema + \".\" + PhaseSummaryNames.SourcePrimaryProc + \"({0}, {1})\", args.CaseId, args.AsOfDate)",
            c);
        Assert.DoesNotContain("FromSqlInterpolated", c);
        // The doc summary names it the same way the SQL does.
        Assert.Contains("typed wrapper around the stored procedure named by <c>PhaseSummaryNames.SourcePrimaryProc</c> in schema <c>PhaseSummaryNames.SourcePrimarySchema</c>.", c);
        // Neither physical name appears in the file — the proc name OR the schema.
        Assert.DoesNotContain("fn_phase_summary", c);
        Assert.DoesNotContain("\"analytics", c);
    }

    [Fact]
    public void NamesOn_table_function_without_schema_has_no_prefix()
    {
        var c = Content(NamesOnFiles(), "ActivePhases.callable.g.cs");
        Assert.Contains(
            ".FromSqlRaw(\"SELECT * FROM \" + ActivePhasesNames.SourcePrimaryFunction + \"({0}, {1})\", args.CaseId, args.AsOfDate)",
            c);
        Assert.Contains("typed wrapper around the table function named by <c>ActivePhasesNames.SourcePrimaryFunction</c>.", c);
        Assert.DoesNotContain("fn_active_phases", c);
    }

    [Fact]
    public void NamesOn_zero_arg_callable_passes_no_parameters()
    {
        var c = Content(NamesOnFiles(), "AllPhases.callable.g.cs");
        Assert.Contains(".FromSqlRaw(\"SELECT * FROM \" + AllPhasesNames.SourcePrimaryProc + \"()\")", c);
        Assert.DoesNotContain("fn_all_phases", c);
    }

    // A text assertion proves what the generated code SAYS; only a compiler proves the
    // expression RESOLVES. Compile the callables together with the entities, the DbContext
    // and the names artifact they reference, against the real EF Core 8 assemblies —
    // `FromSqlRaw(string, params object[])` is a Relational extension, and the concatenation
    // must be a legal argument for it. The engine-level half (the identifier reaching
    // Postgres as text, the arguments as parameters) was measured against a live database
    // when this arm was built; it is not reproducible in this Docker-free suite.
    [Fact]
    public void NamesOn_callables_compile_against_EF_Core_8_with_the_names_artifact()
    {
        var ctx = NamesCtx(Load());
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new NamesGenerator().Generate(ctx))
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new CallableGenerator().Generate(ctx))
            .ToList();
        Assert.Equal(3, sources.Count(f => f.Path.EndsWith(".callable.g.cs", StringComparison.Ordinal)));

        var trees = sources.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var comp = CSharpCompilation.Create(
            "fr015_names_on_" + Guid.NewGuid().ToString("N"),
            trees, DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0,
            "names-ON callables should compile against EF Core 8 alongside the names artifact, but got:\n"
                + string.Join("\n", errors));
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
