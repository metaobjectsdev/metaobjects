namespace MetaObjects.Cli.Tests;

/// <summary>
/// The generator selection the gen/verify MECHANICS tests use.
/// </summary>
/// <remarks>
/// <para>These tests are about the write path, the hash manifest, baselines, column
/// naming, template-spec resolution and drift detection — not about which generators an
/// application should run. They used to get a suite for free from
/// <c>GenCommand.DefaultGeneratorNames</c>, which is gone: codegen is opt-in, and a
/// caller that names no generator now gets a usage error and an empty out dir.</para>
/// <para>So the suite is named here, ONCE, and it is deliberately the nine that used to
/// be the default — these tests' fixtures and assertions were written against exactly
/// that output, and changing what they generate would change what they are testing.
/// This is a test-local convenience, not a default restored by the back door: nothing in
/// the CLI reads it.</para>
/// </remarks>
internal static class GenSuite
{
    internal static readonly IReadOnlyList<string> Names =
    [
        "entity", "names", "db-context", "routes", "filter-allowlist",
        "payload", "output-parser", "output-prompt", "extractor",
    ];

    /// <summary>`GenCommand.Run` over <see cref="Names"/> — the old 4-arg convenience
    /// overload, moved into the tests that were its only callers.</summary>
    internal static GenCommand.Outcome Run(
        string metadataDir, string outDir, string ns, bool emitAbstractShapes = false) =>
        GenCommand.Run(metadataDir, outDir, ns, emitAbstractShapes, Names, templateRoot: null);
}
