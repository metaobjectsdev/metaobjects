// GeneratorApplicability — what the api-docs generator asks of the generators it documents.
//
// The api reference documents the code the OTHER generators emit, and it decides what to
// document by asking each of them "would you emit for this?" — the static `AppliesTo` every
// one of those generators exposes. Asked of the packaged generators, the answer describes the
// packaged code. A project that owns a copy of `routes` and changed which entities it serves
// needs the answer to come from ITS copy, or the docs document a surface nobody generates.
//
// So the question is not hard-wired. The docs generator reads the answers from
// `GenContext.Applicability`, and whoever runs the docs fills it in: `dotnet meta docs` with the
// packaged generators, an owned `codegen/Program.cs` with the generator list the project runs
// (`From`). The docs generator itself — packaged or ejected — names no emitting generator, so an
// owned copy of it depends on nothing but this engine surface.

using System.Reflection;
using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>
/// One answer per generator the api reference documents: does it emit for this object or
/// template. Defaults to the packaged generators' own predicates (<see cref="Packaged"/>).
/// </summary>
public sealed record GeneratorApplicability
{
    /// <summary><c>db-context</c> — a DbSet on the generated context.</summary>
    public required Func<MetaObject, MetaRoot, bool> DbContext { get; init; }
    /// <summary><c>routes</c> — the object's CRUD route handlers.</summary>
    public required Func<MetaObject, MetaRoot, bool> Routes { get; init; }
    /// <summary><c>filter-allowlist</c> — the object's filter allowlist.</summary>
    public required Func<MetaObject, bool> FilterAllowlist { get; init; }
    /// <summary><c>render-helper</c> — the template's render helper.</summary>
    public required Func<MetaData, MetaRoot, bool> RenderHelper { get; init; }
    /// <summary><c>output-prompt</c> — the template's response-format fragment.</summary>
    public required Func<MetaData, MetaRoot, bool> OutputPrompt { get; init; }
    /// <summary><c>output-parser</c> — the template's reply parser.</summary>
    public required Func<MetaData, MetaRoot, bool> OutputParser { get; init; }

    /// <summary>The packaged generators' own predicates.</summary>
    public static GeneratorApplicability Packaged { get; } = new()
    {
        DbContext = DbContextGenerator.AppliesTo,
        Routes = RoutesGenerator.AppliesTo,
        FilterAllowlist = FilterAllowlistGenerator.AppliesTo,
        RenderHelper = RenderHelperGenerator.AppliesTo,
        OutputPrompt = OutputPromptGenerator.AppliesTo,
        OutputParser = OutputParserGenerator.AppliesTo,
    };

    /// <summary>The registry name of the generator that answers each question, keyed by the
    /// property that carries the answer — what <see cref="From"/> looks for in a run's list.</summary>
    public static IReadOnlyDictionary<string, string> Sources { get; } = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [nameof(DbContext)] = "db-context",
        [nameof(Routes)] = "routes",
        [nameof(FilterAllowlist)] = "filter-allowlist",
        [nameof(RenderHelper)] = "render-helper",
        [nameof(OutputPrompt)] = "output-prompt",
        [nameof(OutputParser)] = "output-parser",
    };

    /// <summary>
    /// The answers for a run of <paramref name="generators"/>: each question is answered by the
    /// matching generator in the list when one is there — an owned copy, whose own
    /// <c>AppliesTo</c> is read — and by the packaged generator when it is not. A generator is
    /// matched the way <see cref="CodegenCli.ComposeGenerators"/> matches it, by the
    /// <see cref="IGenerator.Name"/> the packaged one carries.
    /// </summary>
    public static GeneratorApplicability From(IEnumerable<IGenerator> generators)
    {
        var run = generators.ToList();
        Delegate? Owned(string property, Type delegateType)
        {
            var packaged = GeneratorRegistry.Get(Sources[property])!.Factory(new GeneratorBuildContext());
            var mine = run.FirstOrDefault(g => g.Name == packaged.Name);
            // A copy that dropped or renamed AppliesTo is not an error here: the question then
            // has no owned answer and the packaged one stands.
            var method = mine?.GetType().GetMethod(
                "AppliesTo", BindingFlags.Public | BindingFlags.Static,
                delegateType.GetMethod("Invoke")!.GetParameters().Select(p => p.ParameterType).ToArray());
            return method is null ? null : Delegate.CreateDelegate(delegateType, method);
        }

        return Packaged with
        {
            DbContext = (Func<MetaObject, MetaRoot, bool>?)Owned(nameof(DbContext), typeof(Func<MetaObject, MetaRoot, bool>)) ?? Packaged.DbContext,
            Routes = (Func<MetaObject, MetaRoot, bool>?)Owned(nameof(Routes), typeof(Func<MetaObject, MetaRoot, bool>)) ?? Packaged.Routes,
            FilterAllowlist = (Func<MetaObject, bool>?)Owned(nameof(FilterAllowlist), typeof(Func<MetaObject, bool>)) ?? Packaged.FilterAllowlist,
            RenderHelper = (Func<MetaData, MetaRoot, bool>?)Owned(nameof(RenderHelper), typeof(Func<MetaData, MetaRoot, bool>)) ?? Packaged.RenderHelper,
            OutputPrompt = (Func<MetaData, MetaRoot, bool>?)Owned(nameof(OutputPrompt), typeof(Func<MetaData, MetaRoot, bool>)) ?? Packaged.OutputPrompt,
            OutputParser = (Func<MetaData, MetaRoot, bool>?)Owned(nameof(OutputParser), typeof(Func<MetaData, MetaRoot, bool>)) ?? Packaged.OutputParser,
        };
    }
}
