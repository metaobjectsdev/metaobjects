// QueryScenarioRunner — executes a QueryScenario end-to-end:
//
//   1. Spin up a Postgres testcontainer.
//   2. Apply the canonical schema (CREATE TABLE/VIEW etc.) — same chain as `meta migrate`.
//   3. Execute the scenario's seed-data SQL.
//   4. Open an AppDbContext pointed at the container.
//   5. For each QuerySpec: translate via DbContextAdapter, normalize the result,
//      compare against the scenario's `expect:` block.

using System.Text.Json.Nodes;
using MetaObjects.Codegen.Migrate;
using MetaObjects.Codegen.Schema;
using MetaObjects.IntegrationTests.Generated;
using MetaObjects.Loader;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Xunit.Sdk;

namespace MetaObjects.IntegrationTests.Runner;

public static class QueryScenarioRunner
{
    public static async Task RunAsync(QueryScenario scenario, PostgresContainer pg, string canonicalMetadataDir)
    {
        // Apply the canonical schema (engine full-CREATE via diff-against-empty).
        await ApplyCanonicalSchemaAsync(pg.ConnectionString, canonicalMetadataDir);

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

    private static async Task ApplyCanonicalSchemaAsync(string connString, string canonicalDir)
    {
        var load = MetaDataLoader.FromDirectory(canonicalDir);
        if (load.Errors.Count > 0)
            throw new InvalidOperationException(
                $"canonical metadata at {canonicalDir} did not load cleanly: " +
                string.Join("; ", load.Errors.Select(e => $"{e.Code}: {e.Message}")));

        // Tables via the engine path; views + enum CHECK + comments via the tail helpers.
        var diff = SchemaDiff.Diff(ExpectedSchema.Build(load.Root), new SchemaSnapshot([]));
        var tableDdl = PostgresEmit.Render(diff.Changes).Up;
        await ExecuteAsync(connString, tableDdl);

        foreach (var stmt in PostgresSchema.EnumCheckConstraints(load.Root))
            await ExecuteAsync(connString, stmt);
        foreach (var stmt in PostgresSchema.TableAndColumnComments(load.Root))
            await ExecuteAsync(connString, stmt);
        foreach (var p in load.Root.Objects().Where(o => o.IsReadOnlyProjection())
                                   .OrderBy(o => o.Name, StringComparer.Ordinal))
            await ExecuteAsync(connString, PostgresSchema.CreateView(p, load.Root, _ => { }));
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
            obj[k] = v is null ? null : JsonValue.Create(v);
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
