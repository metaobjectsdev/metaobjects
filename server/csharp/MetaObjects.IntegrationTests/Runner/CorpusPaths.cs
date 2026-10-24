// CorpusPaths — resolves the persistence-conformance corpus location relative to
// the test assembly. Shared by the query-scenario runner + tests.

using MetaObjects.Config;
using MetaObjects.Meta;

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
    /// The query scenarios <paramref name="engine"/> runs, as xUnit member data: one home for the
    /// <c>engines:</c> rule (see <see cref="QueryScenario.RunsOn"/>), so a dialect-gated scenario
    /// cannot be silently skipped by one lane's enumeration.
    /// </summary>
    public static IEnumerable<object[]> ScenariosFor(ScenarioEngine engine) =>
        Directory.EnumerateFiles(QueriesDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Where(p => ScenarioLoader.LoadQuery(p).RunsOn(engine))
            .Select(p => new object[] { p });

    /// <summary>
    /// The committed canonical Postgres schema artifact. TypeScript is the single
    /// producer of this DDL (base tables + projection views, literal column naming);
    /// every port's query-scenario runner executes it verbatim to provision its test
    /// DB. See docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md.
    /// </summary>
    public static readonly string CanonicalSchemaSql =
        Path.Combine(CanonicalDir, "schema.postgres.sql");

    /// <summary>
    /// The committed canonical SQLite schema artifact — the same tables and report views,
    /// produced by TypeScript (<c>meta migrate --dialect sqlite</c>'s diff + emit).
    /// </summary>
    public static readonly string CanonicalSchemaSqliteSql =
        Path.Combine(CanonicalDir, "schema.sqlite.sql");

    /// <summary>
    /// The committed canonical MySQL schema artifact: the adopter's tables (MySQL is not owned
    /// by <c>meta migrate</c>, ADR-0015) plus the report views TypeScript lowers with
    /// <c>buildReportViews</c>.
    /// </summary>
    public static readonly string CanonicalSchemaMysqlSql =
        Path.Combine(CanonicalDir, "schema.mysql.sql");

    /// <summary>
    /// The canonical entity metadata for the corpus. The M:N runtime resolver
    /// (<see cref="M2MResolver"/>) loads it to derive junction FK fields from the
    /// junction entity's <c>identity.reference</c> children (FR-017).
    /// </summary>
    public static readonly string CanonicalMetadataDir = CanonicalDir;

    /// <summary>
    /// The corpus's single metadata file. <see cref="QueryScenarioRunner.LoadCorpusMetadata"/>
    /// loads exactly this file, the one metadata file the corpus declares.
    /// </summary>
    public static readonly string FitnessMetadataFile = Path.Combine(CanonicalDir, "meta.fitness.json");

    /// <summary>
    /// ADR-0058 — the corpus's committed physical-naming rules, read with the C# config
    /// reader: <c>fixtures/persistence-conformance/.metaobjects/config.json</c>
    /// pins <c>{"naming":{"columns":"literal"}}</c>, matching the committed schema artifacts.
    /// </summary>
    public static readonly PhysicalNaming Naming = NeutralConfig.Read(Corpus)?.Naming ?? PhysicalNaming.Default;

    /// <summary>
    /// ADR-0019 Amendment 2 — the corpus's pinned wire setting, read from the same file as
    /// <see cref="Naming"/>: the corpus pins the cross-port form
    /// (<c>{"wire":{"decimals":"string","nullMembers":"omit"}}</c>); a project's default is native.
    /// </summary>
    public static readonly WireFormat Wire = NeutralConfig.Read(Corpus)?.Wire ?? WireFormat.Default;
}
