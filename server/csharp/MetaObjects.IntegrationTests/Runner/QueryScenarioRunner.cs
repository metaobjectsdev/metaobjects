// QueryScenarioRunner — executes a QueryScenario end-to-end:
//
//   1. Spin up a Postgres testcontainer.
//   2. Provision the schema by executing the committed canonical schema DDL
//      (fixtures/persistence-conformance/canonical/schema.postgres.sql) verbatim.
//   3. Execute the scenario's seed-data SQL.
//   4. Open an AppDbContext pointed at the container.
//   5. For each QuerySpec: translate via DbContextAdapter, normalize the result,
//      compare against the scenario's `expect:` block.
//
// C# no longer synthesizes the query-scenario schema from metadata — TypeScript
// is the single PRODUCER of one committed DDL artifact (drift-checked on the TS
// side) that every port executes verbatim. The committed DDL uses literal column
// names; the generated AppDbContext entities map to those exact names via
// [Column(...)], so the EF Core runtime addresses the schema's columns directly.
// See docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md.

using System.Globalization;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Generated;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;
using Xunit.Sdk;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Runner;

public static class QueryScenarioRunner
{
    public static Task RunAsync(QueryScenario scenario, PostgresContainer pg) =>
        RunAsync(scenario, ScenarioEngine.Postgres, pg.ConnectionString);

    /// <summary>
    /// Run a scenario against a SQLite database file the caller owns (an empty file path is
    /// created on first use). The expectations are the Postgres wire ones: the engine
    /// spelling is mapped only by <see cref="Normalization"/> on the actual side.
    /// </summary>
    public static Task RunSqliteAsync(QueryScenario scenario, string databasePath) =>
        RunAsync(scenario, ScenarioEngine.Sqlite, $"Data Source={databasePath}");

    /// <summary>
    /// Run a scenario against a MySQL database (a fresh, empty one). The expectations are the
    /// Postgres wire ones, unchanged; <see cref="Normalization"/> maps the engine spelling.
    /// </summary>
    public static Task RunMySqlAsync(QueryScenario scenario, string connectionString) =>
        RunAsync(scenario, ScenarioEngine.MySql, connectionString);

    private static async Task RunAsync(QueryScenario scenario, ScenarioEngine engine, string connectionString)
    {
        // Provision the schema from the committed canonical DDL — the single
        // TS-produced artifact every port executes. (No per-scenario synthesis.)
        await ExecuteAsync(engine, connectionString, ReadCanonicalSchemaSql(engine));

        // Optional seed data (a per-engine `seed-data-engine` entry wins over `seed-data`).
        var seed = scenario.SeedFor(engine.Name());
        if (!string.IsNullOrWhiteSpace(seed))
        {
            // The corpus seed is Postgres SQL unless a per-engine entry spells it; MySQL's
            // identifier quote differs, so a Postgres-spelled seed is translated.
            if (engine == ScenarioEngine.MySql && !scenario.HasSeedFor(engine.Name()))
                seed = MySqlSeed.FromPostgres(seed);
            await ExecuteAsync(engine, connectionString, seed);
        }

        // Open a DbContext + run each query.
        var builder = new DbContextOptionsBuilder<AppDbContext>();
        var options = (engine switch
        {
            ScenarioEngine.Sqlite => builder.UseSqlite(connectionString),
            ScenarioEngine.MySql => builder.UseMySql(connectionString, new MySqlServerVersion(new System.Version(8, 4, 0))),
            _ => builder.UseNpgsql(connectionString),
        }).Options;
        // Postgres runs the whole generated context; the other engines read the report views
        // through the view-only subset (see ReportViewsDbContext).
        await using AppDbContext db = engine == ScenarioEngine.Postgres
            ? new AppDbContext(options)
            : new ReportViewsDbContext(options);

        // Metadata is loaded lazily — only `op: relate` (M:N traversal) needs it,
        // and it drives the junction-FK derivation via the shared M2MDerivation
        // helper. The non-M:N scenarios stay metadata-free (pure EF over the DDL).
        MetaRoot? metaRoot = null;

        foreach (var spec in scenario.Queries)
        {
            if (spec.Op == "relate")
            {
                metaRoot ??= LoadCorpusMetadata();
                if (engine != ScenarioEngine.Postgres)
                    throw new InvalidOperationException($"{scenario.SourcePath}: op:relate runs on Postgres only");
                var actual = await ResolveRelateAsync(connectionString, metaRoot, spec);
                AssertResult(scenario.SourcePath, spec, actual);
                continue;
            }

            // FR-017 TPH: an op marked `expectError: true` (a cross-subtype write) MUST
            // be rejected by the runtime — a throw is the pass. EF's own
            // DbUpdateException, our subtype-scope/column guards, and a not-found all
            // count. Note: an `expectError` op may leave a tracked entity in a bad state,
            // so clear the change tracker before the next op proceeds.
            if (spec.ExpectError)
            {
                try
                {
                    await DbContextAdapter.ExecuteAsync(db, spec);
                }
                catch (Exception)
                {
                    db.ChangeTracker.Clear();
                    continue; // rejected as required
                }
                db.ChangeTracker.Clear();
                throw new XunitException(
                    $"{scenario.SourcePath} / {spec.Name}: expected the op to be rejected (expectError: true) but it succeeded");
            }

            if (spec.Op == "roundtrip")
            {
                // WRITE round-trip: INSERT via the EF runtime, read back by PK, drop
                // the PK, assert the normalized read-back == `expect`. Exercises the
                // write codec + read path together (the structural complement to the
                // read-only scenarios). See RoundtripWriter.
                var written = await RoundtripWriter.ExecuteAsync(db, spec);
                AssertResult(scenario.SourcePath, spec, written);
                continue;
            }

            var efActual = await DbContextAdapter.ExecuteAsync(db, spec);
            AssertResult(scenario.SourcePath, spec, efActual);
        }
    }

    /// <summary>Load the canonical corpus metadata (the M:N relationship + junction declarations).</summary>
    private static MetaRoot LoadCorpusMetadata()
    {
        var result = MetaDataLoader.FromDirectory(CorpusPaths.CanonicalMetadataDir);
        if (result.Errors.Count > 0)
            throw new InvalidOperationException(
                "failed to load corpus metadata: " + string.Join("; ", result.Errors.Select(e => e.Message)));
        return result.Root;
    }

    /// <summary>Execute an <c>op: relate</c> M:N traversal via the runtime resolver.</summary>
    private static async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> ResolveRelateAsync(
        string connString, MetaRoot root, QuerySpec spec)
    {
        if (spec.By is null || spec.By.Count != 1)
            throw new InvalidOperationException($"op:relate '{spec.Name}' requires a single-field `by` (the source record key)");
        if (string.IsNullOrEmpty(spec.Relation))
            throw new InvalidOperationException($"op:relate '{spec.Name}' requires `relation`");
        var sourceId = spec.By.Values.First();
        // Open the consumer-style ADO.NET connection and hand it to the SHIPPING
        // resolver (MetaObjects.Codegen.Runtime.M2MResolver) — the same provider-
        // neutral surface a real C# adopter calls. No resolver logic lives here.
        await using var conn = new NpgsqlConnection(connString);
        await conn.OpenAsync();
        return await MetaObjects.Codegen.Runtime.M2MResolver.RelateAsync(
            conn, root, spec.Entity, sourceId, spec.Relation!);
    }

    /// <summary>Read the committed canonical schema artifact of <paramref name="engine"/> (TS-produced).</summary>
    private static string ReadCanonicalSchemaSql(ScenarioEngine engine)
    {
        var path = engine switch
        {
            ScenarioEngine.Sqlite => CorpusPaths.CanonicalSchemaSqliteSql,
            ScenarioEngine.MySql => CorpusPaths.CanonicalSchemaMysqlSql,
            _ => CorpusPaths.CanonicalSchemaSql,
        };
        if (!File.Exists(path))
            throw new InvalidOperationException(
                $"canonical schema artifact not found at {path}; it is produced by the " +
                "TypeScript conformance tooling and committed to the corpus.");
        return File.ReadAllText(path);
    }

    private static async Task ExecuteAsync(ScenarioEngine engine, string connString, string sql)
    {
        if (engine == ScenarioEngine.Sqlite)
        {
            await using var lite = new SqliteConnection(connString);
            await lite.OpenAsync();
            await using var liteCmd = lite.CreateCommand();
            liteCmd.CommandText = sql;
            await liteCmd.ExecuteNonQueryAsync();
            return;
        }
        if (engine == ScenarioEngine.MySql)
        {
            await using var my = new MySqlConnection(connString);
            await my.OpenAsync();
            await using var myCmd = new MySqlCommand(sql, my);
            await myCmd.ExecuteNonQueryAsync();
            return;
        }
        await using var conn = new NpgsqlConnection(connString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }

    // -----------------------------------------------------------------------
    // Result assertion (every comparison is JSON-canonical byte equality)
    // -----------------------------------------------------------------------

    private static void AssertResult(string scenarioPath, QuerySpec spec, object? actual)
    {
        var expectedJson = CanonicalizeExpected(spec.Expect, spec.Op);
        var actualJson   = CanonicalizeActual(actual, spec.Op);
        if (expectedJson != actualJson)
            throw new XunitException(
                $"{scenarioPath} / {spec.Name}: result mismatch\n  expected: {expectedJson}\n  actual:   {actualJson}");
    }

    private static string CanonicalizeExpected(YamlNode? expect, string op)
    {
        // For `op:count` the expected is logically an integer; parse the scalar so
        // the comparison is number-vs-number, not string-vs-number.
        if (op == "count")
        {
            var raw = (expect as YamlScalarNode)?.Value;
            if (raw is null || !long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
                throw new InvalidOperationException($"op:count expects an integer, got: {raw ?? "null"}");
            return n.ToString(CultureInfo.InvariantCulture);
        }
        // `delete` returns a boolean outcome (true = a row was deleted); the `expect:`
        // is the bare boolean scalar. Canonicalize both sides as a JSON bool string.
        if (op == "delete")
            return ((expect as YamlScalarNode)?.Value?.ToLowerInvariant()) == "true" ? "true" : "false";
        // `relate` (M:N navigation) is a SET — order is not part of the contract,
        // so sort both sides for a deterministic, port-agnostic comparison. The
        // scenario does not (and must not) pin order via `sort:`.
        if (op == "relate")
            return CanonicalRowSet(YamlExpectToJsonNode(expect) as JsonArray ?? []);
        return Canonical(YamlExpectToJsonNode(expect));
    }

    /// <summary>
    /// Canonical JSON of a row SET: each row canonicalized (keys sorted), then the
    /// per-row strings sorted, so the comparison is order-independent. Mirrors the
    /// TS runner's <c>canonicalRowSet</c>.
    /// </summary>
    private static string CanonicalRowSet(JsonArray rows)
    {
        var each = rows.Select(r => Canonical(r)).OrderBy(s => s, StringComparer.Ordinal);
        return "[" + string.Join(",", each) + "]";
    }

    // Convert the raw `expect:` YAML subtree to a JsonNode, honoring scalar STYLE so
    // the comparison matches the wire contract (normalization.md): a plain (unquoted)
    // scalar is YAML-core-schema-inferred (45 → number, true → bool, null/~ → null),
    // while a QUOTED scalar is always a JSON string ("45" → "45"). This is exactly the
    // type inference the TS authority's JS YAML loader performs; without it every
    // INTEGER-typed expectation would degrade to a string and never match the
    // number-shaped actual rows.
    private static JsonNode? YamlExpectToJsonNode(YamlNode? node)
    {
        switch (node)
        {
            case null:
            case YamlScalarNode { Value: null }:
                return null;
            case YamlScalarNode scalar:
                return ScalarToJsonNode(scalar);
            case YamlMappingNode map:
                var obj = new JsonObject();
                foreach (var (k, v) in map.Children)
                    obj[((YamlScalarNode)k).Value!] = YamlExpectToJsonNode(v);
                return obj;
            case YamlSequenceNode seq:
                var arr = new JsonArray();
                foreach (var item in seq.Children) arr.Add(YamlExpectToJsonNode(item));
                return arr;
            default:
                throw new InvalidOperationException($"unsupported YAML node kind in expect: {node.GetType().Name}");
        }
    }

    // A quoted scalar is always a string. A plain scalar follows YAML core-schema
    // inference: null/~ → null, true/false → bool, integer → long, otherwise the
    // literal string (NUMERIC/BIGINT/UUID/float values are authored as strings, so
    // floats and big integers stay strings here and the contract's string forms hold).
    private static JsonNode? ScalarToJsonNode(YamlScalarNode scalar)
    {
        var value = scalar.Value!;
        var quoted = scalar.Style is ScalarStyle.SingleQuoted or ScalarStyle.DoubleQuoted;
        if (quoted) return JsonValue.Create(value);

        switch (value)
        {
            case "" or "~" or "null" or "Null" or "NULL":
                return null;
            case "true" or "True" or "TRUE":
                return JsonValue.Create(true);
            case "false" or "False" or "FALSE":
                return JsonValue.Create(false);
        }
        if (long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var l))
            return JsonValue.Create(l);
        return JsonValue.Create(value);
    }

    private static string CanonicalizeActual(object? actual, string op)
    {
        // `delete` returns a boolean (true = a row was deleted).
        if (op == "delete")
            return actual is true ? "true" : "false";
        // `relate` is a SET: normalize each row, then sort the canonical row strings.
        if (op == "relate")
        {
            var rows = actual as IReadOnlyList<IReadOnlyDictionary<string, object?>>
                ?? throw new InvalidOperationException("op:relate result must be a list of rows");
            return CanonicalRowSet(new JsonArray(rows.Select(RowToJsonNode).Cast<JsonNode?>().ToArray()));
        }

        JsonNode? node = actual switch
        {
            null => null,
            long l => JsonValue.Create(l),
            IReadOnlyDictionary<string, object?> row => RowToJsonNode(row),
            IReadOnlyList<IReadOnlyDictionary<string, object?>> rows =>
                new JsonArray(rows.Select(RowToJsonNode).Cast<JsonNode?>().ToArray()),
            _ => ToJsonNode(actual),
        };
        return Canonical(node);
    }

    private static JsonNode RowToJsonNode(IReadOnlyDictionary<string, object?> row)
    {
        var obj = new JsonObject();
        foreach (var (k, v) in Normalization.NormalizeRow(row))
            obj[k] = Normalization.ToJsonValue(v);
        return obj;
    }

    private static JsonNode? ToJsonNode(object? value)
    {
        switch (value)
        {
            case null:     return null;
            case bool b:   return JsonValue.Create(b);
            case string s: return JsonValue.Create(s);
            case int i:    return JsonValue.Create(i);
            case long l:   return JsonValue.Create(l);
            case double d: return JsonValue.Create(d);
            // YamlDotNet hands nested mappings back as IDictionary<object, object?>;
            // dictionaries built in code use IDictionary<string, object?>. Handle both.
            case IDictionary<object, object?> objDict:
                return DictToJsonNode(objDict, k => k.ToString()!);
            case IDictionary<string, object?> strDict:
                return DictToJsonNode(strDict, k => k);
            case System.Collections.IEnumerable list:
                var arr = new JsonArray();
                foreach (var item in list) arr.Add(ToJsonNode(item));
                return arr;
            default:
                return JsonValue.Create(value.ToString());
        }
    }

    private static JsonNode DictToJsonNode<TKey>(IDictionary<TKey, object?> dict, Func<TKey, string> keyOf)
    {
        var obj = new JsonObject();
        foreach (var (k, v) in dict) obj[keyOf(k)] = ToJsonNode(v);
        return obj;
    }

    private static string Canonical(JsonNode? node) => Normalization.CanonicalJson(node);
}
