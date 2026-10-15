// Repo-root and shared-corpus discovery for this test assembly.
//
// CodegenCompileConformanceTests and IntegrationFixtureDriftTests each hand-rolled the
// same walk-up-from-AppContext.BaseDirectory; this is that walk, once. Mirrors the
// relative-discovery approach in MetaObjects.IntegrationTests/Runner/CorpusPaths.cs —
// the two test projects each keep one copy because internal classes do not cross
// assembly boundaries — and likewise hardcodes no depth, so it survives a change to
// the build output path.

using MetaObjects.Config;
using MetaObjects.Meta;

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

    /// <summary>The persistence corpus root — where its <c>.metaobjects/config.json</c> lives, above
    /// every metadata directory it holds so no directory load reads it as metadata.</summary>
    internal static string CorpusDir =>
        Path.Combine(RepoRoot(), "fixtures", "persistence-conformance");

    /// <summary>The canonical model's directory.</summary>
    internal static string CanonicalDir => Path.Combine(CorpusDir, "canonical");

    /// <summary>
    /// ADR-0058 — the corpus's committed physical-naming rules, read with the C# config
    /// reader (not hardcoded): <c>fixtures/persistence-conformance/.metaobjects/config.json</c>
    /// pins <c>{"naming":{"columns":"literal"}}</c>, matching the committed schema artifacts'
    /// literal column names. Every codegen gate that generates from this corpus reads this
    /// instead of passing a strategy value, so a future change to that file is honoured here too.
    /// </summary>
    internal static PhysicalNaming Naming =>
        NeutralConfig.Read(CorpusDir)?.Naming ?? PhysicalNaming.Default;

    /// <summary>The shared fitness corpus every codegen gate generates from.</summary>
    internal static string FitnessMetadata =>
        Path.Combine(RepoRoot(), "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

    /// <summary>
    /// The on-disk mustache the corpus's <c>@textRef</c> points at. The render-helper
    /// generator runs a build-time drift gate against it, and it ships beside the model so
    /// every port's lane resolves the same bytes.
    /// </summary>
    internal static string FitnessTemplateRoot =>
        Path.Combine(RepoRoot(), "fixtures", "persistence-conformance", "canonical", "prompts");
}
