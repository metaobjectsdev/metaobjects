// CODEGEN-COMPILE CONFORMANCE (C# lane)
//
// Generate from the SHARED cross-port corpus — fixtures/persistence-conformance/
// canonical/meta.fitness.json — and compile every emitted file with the real C#
// compiler. Zero errors or the lane is red.
//
// WHY THIS EXISTS. Four defects shipped in 1.0.4 that every existing gate was blind to,
// because each one produced output that PARSES and GENERATES cleanly and only fails when
// somebody builds it:
//
//   - a view over an int-backed enum imported a codec drizzle does not export (TS);
//   - a renamed projection field selected a column that does not exist (TS);
//   - a DbContext named FK config through `nameof` on a member that is not there (C#);
//   - an extract mapper did not compile for most scalar subtypes (Java).
//
// `dotnet meta gen` exits 0 in all four cases. The metamodel, render, persistence,
// api-contract and registry corpora all stay green — they gate BEHAVIOR, and none of them
// asks whether the emitted code builds. The adopter's build is the first thing that does,
// which makes the adopter the gate. This closes that.
//
// WHY THIS IS NOT DbContextCompileTests. That test compiles a HAND-BUILT model chosen to
// corner specific EF API surfaces, and it is the right tool for that. This one compiles
// the shared corpus every other port also generates from, so a defect that needs the real
// model's shape — 18 entities resolving against each other, two view-backed projections,
// a self-joining M:N, a 5-entity TPH hierarchy with a subtype as an FK / M:N target — is caught by the same fixture in five
// languages rather than by whichever port happened to hand-write a case for it.
//
// WHY THIS IS NOT IntegrationFixtureDriftTests. That one already loads this corpus and
// runs this generator set, but it diffs the output against committed golden files. A
// golden proves the output did not CHANGE; it says nothing about whether it ever
// compiled. Both goldens and their generator can be wrong together — and were.
//
// WHAT IT RUNS: entity + db-context + filter-allowlist + callable, plus names on the
// selection that includes it. The PROMPT tier (output-parser / output-prompt /
// render-helper / extractor) is in scope as of 2026-09-22, as its own selection. It used to
// be excluded on the grounds that the corpus declared no `template.*` node, which was true
// and was the whole problem: the tier ADR-0056 rewrote sat outside the one gate that asks
// whether emitted code compiles, and a lowercase-initial template name duly shipped
// emitting a TypeScript extractor importing a symbol its parser exports under a different
// capitalization. The corpus now declares a responding `template.prompt`, deliberately
// lowercase-initial.
//
// WHAT IT EXCLUDES: RoutesGenerator, the one generator here whose output imports the
// ASP.NET Core shared framework, which is not in the TRUSTED_PLATFORM_ASSEMBLIES sandbox
// an in-memory Roslyn compilation gets. Every peer port draws the same line for the same
// reason (TS omits routesFile, Java omits SpringControllerGenerator), so the boundary is
// a cross-port rule rather than a local concession. Generated routes are compiled in the
// docker-gated api-contract integration lane, where a real web host is present.
//
// The peer lanes are the same test in each port. If one port drops out, that port keeps
// precisely the bug class this exists to catch — so a skip here is never "just this lane".

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CodegenCompileConformanceTests
{
    private const string GeneratedNamespace = "MetaObjects.CompileConformance.Generated";

    private static string CorpusMetadata => CorpusPaths.FitnessMetadata;

    private static MetaRoot LoadCorpus()
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusMetadata)]);
        Assert.True(
            result.Errors.Count == 0,
            "The shared corpus must load cleanly before anything can be generated from it:\n"
                + string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    /// <summary>
    /// The two selections a real `dotnet meta gen` can produce for this tier. Both are
    /// documented, individually-selectable subsets, and the SECOND one is the shape that
    /// actually broke: running entity + db-context WITHOUT names once emitted a reference
    /// to a <c>&lt;Owner&gt;Names</c> class no generator in that run produced (CS0103).
    /// GenConfig.IncludeNames exists to close that, so this gate has to exercise both
    /// settings — a single-configuration run would let the regression back in through the
    /// selection nobody tested.
    /// </summary>
    public static TheoryData<string, bool> Selections => new()
    {
        { "entity,db-context,filter-allowlist,callable,names", true },
        { "entity,db-context,filter-allowlist,callable", false },
        // The template tier. `entity` rides with it because ADR-0056 made the tier
        // reference each value object's OWN POCO rather than a template-named copy, so it
        // does not compile alone and a selection without it would prove nothing about the
        // reference.
        { "entity,db-context,filter-allowlist,callable,names,render-helper,output-prompt,output-parser,extractor", true },
    };

    [Theory]
    [MemberData(nameof(Selections))]
    public void Every_generated_file_compiles_with_zero_errors(string selection, bool includeNames)
    {
        var root = LoadCorpus();
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig
            {
                // Never written — this run compiles in memory and emits nothing to disk.
                OutDir = Path.Combine(Path.GetTempPath(), "unused-compile-conformance"),
                Namespace = GeneratedNamespace,
                ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                IncludeNames = includeNames,
                EmitAbstractShapes = false,
            },
        };

        // Each C# generator decides its own applicability INSIDE Generate(ctx) — via an
        // inline predicate or the PerEntityGenerator.Filter hook — so unlike the TS lane
        // there is no runner-level `matches` to compose here. Calling Generate directly IS
        // how CodegenRunner runs them, so this measures the emit and not the harness.
        var generators = new List<IGenerator>
        {
            new EntityGenerator(),
            new DbContextGenerator(),
            new FilterAllowlistGenerator(),
            new CallableGenerator(),
        };
        if (includeNames) generators.Add(new NamesGenerator());

        // The template tier is ADDED to the coherent base selection, never substituted for
        // it. Clearing the list and generating the tier alone reproduced precisely the
        // CS0103 this gate exists to catch — `entity` references `<Owner>Names` under
        // IncludeNames, and the query helpers reference AppDbContext from `db-context`, so
        // a tier-only run is an incoherent selection rather than a narrower one.
        var isTemplateTier = selection.Contains("render-helper", StringComparison.Ordinal);
        if (isTemplateTier)
        {
            generators.Add(new RenderHelperGenerator(CorpusPaths.FitnessTemplateRoot));
            generators.Add(new OutputPromptGenerator());
            generators.Add(new OutputParserGenerator());
            generators.Add(new ExtractorGenerator());
        }

        var files = generators.SelectMany(g => g.Generate(ctx)).ToList();
        Assert.True(files.Count > 0, $"selection '{selection}' generated no files at all");

        if (isTemplateTier)
        {
            // A compile gate passes trivially on an empty emit, so name what this selection
            // must have produced rather than trusting a file count.
            var emitted = files.Select(f => Path.GetFileName(f.Path)).ToHashSet(StringComparer.Ordinal);
            // This port names a template artifact `<templateName>.<tier>.cs` — the authored
            // template name as the stem, as the TS port does, while the JVM ports use
            // `<CapitalizedName><Tier>` because a JVM file name must match its public type.
            // That split is idiomatic per-port file naming, not a divergence: the CLASS
            // names inside are capitalized in every port.
            foreach (var expected in new[]
                     {
                         "coachNote.render.cs", "coachNote.response.cs",
                         "coachNote.responseFormat.cs",
                         "ProgramBrief.g.cs", "ProgramVerdict.g.cs", "WeekLabel.g.cs",
                         "ProgramVerdictExtracted.g.cs",
                     })
            {
                Assert.True(emitted.Contains(expected),
                    $"expected {expected} in the emitted tree; saw {string.Join(", ", emitted.OrderBy(x => x, StringComparer.Ordinal))}");
            }
        }

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path))
            .ToList();
        var comp = CSharpCompilation.Create(
            "codegen_compile_conformance_" + Guid.NewGuid().ToString("N"),
            trees,
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        // Errors only, matching every other Roslyn test in this project. Generated code is
        // allowed to be warned about (an unused using is not an adopter's broken build);
        // it is not allowed to fail to compile.
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d =>
            {
                var span = d.Location.GetLineSpan();
                var where = string.IsNullOrEmpty(span.Path) ? "" : $"{span.Path}:{span.StartLinePosition.Line + 1} ";
                return $"{where}{d.Id}: {d.GetMessage()}";
            })
            .OrderBy(s => s, StringComparer.Ordinal)
            .ToList();

        Assert.True(
            errors.Count == 0,
            $"`dotnet meta gen --generators {selection}` over the shared fitness corpus emitted "
                + $"{files.Count} file(s) that do not compile ({errors.Count} error(s)):\n"
                + string.Join("\n", errors));
    }
}
