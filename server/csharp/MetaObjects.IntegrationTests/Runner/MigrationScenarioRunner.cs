// MigrationScenarioRunner — executes a MigrationScenario end-to-end:
//
//   1. Spin up a Postgres testcontainer.
//   2. If `seed-metadata` is present: load it, run `MigrateCommand.Run` (full-CREATE
//      from empty) to bootstrap the starting schema, then execute the resulting SQL
//      against the container.
//   3. If `seed-data` is present: execute it against the container.
//   4. Connect via NpgsqlIntrospector and run MigrateCommand.RunIncrementalAsync
//      against the target metadata to produce up + down SQL.
//   5. Validate the expected blocked changes + `up-contains` substrings.
//   6. If `apply-up-then-query` is present: execute the up SQL, then run the post
//      query and compare normalized rows.

using MetaObjects.Cli;
using MetaObjects.Codegen.Migrate;
using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Npgsql;
using Xunit.Sdk;

namespace MetaObjects.IntegrationTests.Runner;

public static class MigrationScenarioRunner
{
    public static async Task RunAsync(MigrationScenario scenario, PostgresContainer pg)
    {
        // 1. Bootstrap the starting schema, if any.
        if (scenario.SeedMetadataDir is { } seedDir)
        {
            var seedSql = BuildFullCreate(seedDir);
            await ExecuteAsync(pg.ConnectionString, seedSql);
        }
        // 2. Seed data.
        if (!string.IsNullOrWhiteSpace(scenario.SeedData))
            await ExecuteAsync(pg.ConnectionString, scenario.SeedData);

        // 3. Run the incremental migration against the target.
        var targetMetadataDir = ResolveTargetMetadata(scenario);
        await using var db = await NpgsqlIntrospector.ConnectAsync(pg.ConnectionString);
        var outcome = await MigrateCommand.RunIncrementalAsync(targetMetadataDir, db);

        // 4. Assertions.
        AssertBlocked(scenario, outcome);
        AssertUpContains(scenario, outcome);
        AssertUpEmpty(scenario, outcome);

        // 5. Apply + post-query (only when nothing was blocked).
        if (scenario.Expect.ApplyUpThenQuery is { } postQuery && outcome.Blocked.Count == 0 && !string.IsNullOrEmpty(outcome.Up))
        {
            await ExecuteAsync(pg.ConnectionString, outcome.Up!);
            var actualRows = await QueryRowsAsync(pg.ConnectionString, postQuery.Sql);
            AssertRows(scenario.SourcePath, "apply-up-then-query", postQuery.Rows, actualRows);
        }
    }

    // -----------------------------------------------------------------------
    // Step helpers
    // -----------------------------------------------------------------------

    private static string BuildFullCreate(string metadataDir)
    {
        var load = MetaDataLoader.FromDirectory(metadataDir);
        if (load.Errors.Count > 0)
            throw new InvalidOperationException(
                $"metadata at {metadataDir} did not load cleanly: " +
                string.Join("; ", load.Errors.Select(e => $"{e.Code}: {e.Message}")));
        var diff = SchemaDiff.Diff(ExpectedSchema.Build(load.Root), new SchemaSnapshot([]));
        return PostgresEmit.Render(diff.Changes).Up;
    }

    // Inline metadata is written to a temp dir and loaded the same way; this is
    // simpler than threading a second loader path through MigrateCommand.
    private static string ResolveTargetMetadata(MigrationScenario s)
    {
        if (s.TargetMetadataDir is not null) return s.TargetMetadataDir;
        if (s.TargetMetadataInline is not null)
        {
            var tmp = Directory.CreateTempSubdirectory("metaobjects-scenario-").FullName;
            File.WriteAllText(Path.Combine(tmp, "meta.json"), s.TargetMetadataInline);
            return tmp;
        }
        throw new InvalidOperationException($"{s.SourcePath}: missing target-metadata / target-metadata-inline");
    }

    // -----------------------------------------------------------------------
    // Assertions — every failure points at scenario.SourcePath for easy navigation
    // -----------------------------------------------------------------------

    private static void AssertBlocked(MigrationScenario s, MigrateCommand.IncrementalOutcome outcome)
    {
        if (s.Expect.Blocked.Count == 0)
        {
            if (outcome.Blocked.Count > 0)
                throw new XunitException(
                    $"{s.SourcePath}: expected no blocked changes; got: {string.Join("; ", outcome.Blocked)}");
            return;
        }
        foreach (var expected in s.Expect.Blocked)
        {
            var hit = outcome.Blocked.Any(b =>
                b.StartsWith(expected.Kind, StringComparison.Ordinal)
                && b.Contains(expected.ReasonContains, StringComparison.Ordinal));
            if (!hit) throw new XunitException(
                $"{s.SourcePath}: expected blocked change of kind '{expected.Kind}' with reason containing " +
                $"'{expected.ReasonContains}'; got: {string.Join("; ", outcome.Blocked)}");
        }
    }

    private static void AssertUpContains(MigrationScenario s, MigrateCommand.IncrementalOutcome outcome)
    {
        foreach (var needle in s.Expect.UpContains)
        {
            if (outcome.Up is null || !outcome.Up.Contains(needle, StringComparison.Ordinal))
                throw new XunitException(
                    $"{s.SourcePath}: up SQL did not contain expected substring '{needle}'.\n--- up SQL ---\n{outcome.Up}");
        }
    }

    private static void AssertUpEmpty(MigrationScenario s, MigrateCommand.IncrementalOutcome outcome)
    {
        if (s.Expect.UpEmpty != true) return;
        if (!string.IsNullOrWhiteSpace(outcome.Up))
            throw new XunitException(
                $"{s.SourcePath}: expected up-empty: true but got non-empty SQL:\n{outcome.Up}");
    }

    private static void AssertRows(
        string scenarioPath, string queryName,
        IReadOnlyList<IReadOnlyDictionary<string, object?>> expected,
        IReadOnlyList<IReadOnlyDictionary<string, object?>> actual)
    {
        var expectedJson = Normalization.CanonicalRowsJson(expected);
        var actualJson = Normalization.CanonicalRowsJson(actual);
        if (expectedJson != actualJson)
            throw new XunitException(
                $"{scenarioPath} / {queryName}: row mismatch.\n  expected: {expectedJson}\n  actual:   {actualJson}");
    }

    // -----------------------------------------------------------------------
    // Postgres helpers
    // -----------------------------------------------------------------------

    private static async Task ExecuteAsync(string connString, string sql)
    {
        await using var conn = new NpgsqlConnection(connString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }

    private static async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> QueryRowsAsync(
        string connString, string sql)
    {
        await using var conn = new NpgsqlConnection(connString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var rows = new List<IReadOnlyDictionary<string, object?>>();
        while (await reader.ReadAsync())
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }
}

