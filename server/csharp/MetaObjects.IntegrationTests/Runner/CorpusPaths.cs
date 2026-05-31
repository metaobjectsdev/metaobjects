// CorpusPaths — resolves the persistence-conformance corpus location relative to
// the test assembly. Shared by the query-scenario runner + tests.

namespace MetaObjects.IntegrationTests.Runner;

/// <summary>Resolves the corpus location relative to this test assembly.</summary>
internal static class CorpusPaths
{
    // Test assemblies run from bin/Debug/net8.0; the corpus lives 6 levels up
    // at the repo root. AppContext.BaseDirectory points at the bin dir.
    public static readonly string Repo = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));

    public static readonly string Corpus = Path.Combine(Repo, "fixtures", "persistence-conformance");
    public static readonly string CanonicalDir = Path.Combine(Corpus, "canonical");
    public static readonly string QueriesDir = Path.Combine(Corpus, "queries");

    /// <summary>
    /// The committed canonical Postgres schema artifact. TypeScript is the single
    /// producer of this DDL (base tables + projection views, literal column naming);
    /// every port's query-scenario runner executes it verbatim to provision its test
    /// DB. See docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md.
    /// </summary>
    public static readonly string CanonicalSchemaSql =
        Path.Combine(CanonicalDir, "schema.postgres.sql");
}
