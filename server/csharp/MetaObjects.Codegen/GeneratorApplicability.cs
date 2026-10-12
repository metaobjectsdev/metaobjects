// GeneratorApplicability — what the api-docs generator asks of the generators it documents.
//
// The api reference documents the code the OTHER generators emit, and it decides what to
// document by asking each of them "would you emit for this?" — the static `AppliesTo` every
// one of those generators exposes. The docs generator does not name those generators: it reads
// the answers from `GenContext.Applicability`, which carries the packaged generators' own
// predicates (`Packaged`). So the docs generator — packaged or ejected — depends on nothing but
// this engine surface, and the reference describes what the packaged generators emit for,
// including in a project that owns a copy of one of them.

using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>
/// One answer per generator the api reference documents: does it emit for this object or
/// template. The answers are the packaged generators' own predicates (<see cref="Packaged"/>).
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
}
