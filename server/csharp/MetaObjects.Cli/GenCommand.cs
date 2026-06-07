// `dotnet meta gen` — generate idiomatic C# (EF Core) code from metadata.
//
// Loads metadata from a directory and runs the codegen generator set, writing
// files under the @generated-header guard. Generated today: EF Core entity
// classes + a DbContext. Routes / projections / migrations layer on next.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;

namespace MetaObjects.Cli;

/// <summary>The gen command's pure logic (no console I/O), so it is testable.</summary>
public static class GenCommand
{
    public sealed record Outcome(IReadOnlyList<string> LoadErrors, CodegenRunner.RunResult? Result)
    {
        public bool Ok => LoadErrors.Count == 0 && Result is not null;
    }

    /// <summary>
    /// The default generator suite's stable names (ADR-0021 D3). Unchanged from the
    /// original hardcoded four: <c>entity</c>, <c>db-context</c>, <c>routes</c>,
    /// <c>output-parser</c>. The other five registered generators are NOT in the
    /// default suite (so existing output is unchanged for everyone) but ARE
    /// selectable by name via <c>--generators</c>.
    /// </summary>
    public static readonly IReadOnlyList<string> DefaultGeneratorNames =
        ["entity", "db-context", "routes", "output-parser"];

    /// <summary>The default generator set, built from the registry by stable name.</summary>
    public static IReadOnlyList<IGenerator> DefaultGenerators() =>
        GeneratorRegistry.Resolve(DefaultGeneratorNames);

    public static Outcome Run(string metadataDir, string outDir, string ns, bool emitAbstractShapes = false) =>
        Run(metadataDir, outDir, ns, emitAbstractShapes, generatorNames: null, templateRoot: null);

    /// <summary>
    /// Run codegen selecting generators by stable name. When
    /// <paramref name="generatorNames"/> is null/empty the default suite runs
    /// (back-compat). An unknown name (or a render-helper selected without a
    /// <paramref name="templateRoot"/>) surfaces as a load-style error in the
    /// returned <see cref="Outcome"/> rather than throwing.
    /// </summary>
    public static Outcome Run(
        string metadataDir, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<string>? generatorNames, string? templateRoot)
    {
        // AI-trace pre-pass: derive typed voRequest/voResponse jsonb columns onto
        // LlmCallBase-derived entities so the EF Core entity codegen emits them
        // without the author restating them. No-op when no trace entities.
        var load = MetaDataLoader.FromDirectory(metadataDir, preFreeze: DeriveTraceFields.Apply);
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, null);

        var names = generatorNames is { Count: > 0 } ? generatorNames : DefaultGeneratorNames;
        IReadOnlyList<IGenerator> generators;
        try
        {
            generators = GeneratorRegistry.Resolve(names, new GeneratorBuildContext(templateRoot));
        }
        catch (ArgumentException ex)
        {
            return new Outcome([ex.Message], null);
        }

        var config = new GenConfig { OutDir = outDir, Namespace = ns, EmitAbstractShapes = emitAbstractShapes };
        var result = CodegenRunner.Run(config, load.Root, generators);
        return new Outcome(loadErrors, result);
    }

    /// <summary>
    /// The lines `dotnet meta gen --list` prints: one `&lt;stable-name&gt; — &lt;description&gt;`
    /// per registered generator, native first. Pure (no console I/O) for testing.
    /// </summary>
    public static IReadOnlyList<string> ListLines() =>
        GeneratorRegistry.List()
            .Select(e => $"  {e.Name} — {e.Description}" + (e.Note is not null ? $" [{e.Note}]" : ""))
            .ToList();
}
