// `meta gen` — generate idiomatic C# (EF Core) code from metadata.
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

    /// <summary>The default generator set. Extended as more generators land.</summary>
    public static IReadOnlyList<IGenerator> DefaultGenerators() =>
        [new EntityGenerator(), new DbContextGenerator(), new RoutesGenerator(), new OutputParserGenerator()];

    public static Outcome Run(string metadataDir, string outDir, string ns)
    {
        var load = MetaDataLoader.FromDirectory(metadataDir);
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, null);

        var config = new GenConfig { OutDir = outDir, Namespace = ns };
        var result = CodegenRunner.Run(config, load.Root, DefaultGenerators());
        return new Outcome(loadErrors, result);
    }
}
