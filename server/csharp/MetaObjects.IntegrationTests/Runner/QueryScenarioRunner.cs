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

using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Generated;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Xunit.Sdk;

namespace MetaObjects.IntegrationTests.Runner;

public static class QueryScenarioRunner
{
    public static async Task RunAsync(QueryScenario scenario, PostgresContainer pg)
    {
        // Provision the schema from the committed canonical DDL — the single
        // TS-produced artifact every port executes. (No per-scenario synthesis.)
        await ExecuteAsync(pg.ConnectionString, ReadCanonicalSchemaSql());

        // Optional seed data.
        if (!string.IsNullOrWhiteSpace(scenario.SeedData))
            await ExecuteAsync(pg.ConnectionString, scenario.SeedData);

        // Open a DbContext + run each query.
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(pg.ConnectionString)
            .Options;
        await using var db = new AppDbContext(options);

        foreach (var spec in scenario.Queries)
        {
            var actual = await DbContextAdapter.ExecuteAsync(db, spec);
            AssertResult(scenario.SourcePath, spec, actual);
        }
    }

    /// <summary>Read the committed canonical Postgres schema artifact (TS-produced).</summary>
    private static string ReadCanonicalSchemaSql()
    {
        var path = CorpusPaths.CanonicalSchemaSql;
        if (!File.Exists(path))
            throw new InvalidOperationException(
                $"canonical schema artifact not found at {path}; it is produced by the " +
                "TypeScript conformance tooling and committed to the corpus.");
        return File.ReadAllText(path);
    }

    private static async Task ExecuteAsync(string connString, string sql)
    {
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

    private static string CanonicalizeExpected(object? expect, string op)
    {
        // YamlDotNet hands back nested mappings as Dictionary<object,object?> and
        // bare scalars (including integers) as strings when the parent property is
        // typed as object?. For `op:count` the expected is logically an integer;
        // parse it so the comparison is number-vs-number, not string-vs-number.
        if (op == "count")
        {
            var n = expect switch
            {
                long l => l,
                int i => i,
                string s when long.TryParse(s, out var p) => p,
                _ => throw new InvalidOperationException($"op:count expects an integer, got: {expect}"),
            };
            return n.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        var node = ToJsonNode(expect);
        return Canonical(node);
    }

    private static string CanonicalizeActual(object? actual, string op)
    {
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
