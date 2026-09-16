// Repo-root and shared-corpus discovery for this test assembly.
//
// CodegenCompileConformanceTests and IntegrationFixtureDriftTests each hand-rolled the
// same walk-up-from-AppContext.BaseDirectory; this is that walk, once. Mirrors the
// relative-discovery approach in MetaObjects.IntegrationTests/Runner/CorpusPaths.cs —
// the two test projects each keep one copy because internal classes do not cross
// assembly boundaries — and likewise hardcodes no depth, so it survives a change to
// the build output path.

namespace MetaObjects.Codegen.Tests;

internal static class CorpusPaths
{
    /// <summary>
    /// Walk up from the test assembly to the repo root (the directory containing the
    /// shared <c>fixtures/</c> corpus and <c>server/</c>).
    /// </summary>
    internal static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "persistence-conformance")) &&
                Directory.Exists(Path.Combine(dir.FullName, "server")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException(
            "Could not locate the repo root (a parent dir containing fixtures/persistence-conformance + server/) " +
            $"starting from {AppContext.BaseDirectory}.");
    }

    /// <summary>The shared fitness corpus every codegen gate generates from.</summary>
    internal static string FitnessMetadata =>
        Path.Combine(RepoRoot(), "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");
}
