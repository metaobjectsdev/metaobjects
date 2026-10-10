// ReportFixture — schema provisioning + seed for the FR-044 report api-contract
// GENERATED lane.
//
// The schema is NOT written here. View SQL is produced by TypeScript only (ADR-0015), so
// this lane executes the committed, TypeScript-produced, drift-checked artifact
// `report/schema.postgres.sql` verbatim: the base tables (`invoices`, `products`, `sales`)
// and the views the served reports read. That artifact carries LITERAL column naming
// (amountCents, issuedOnMonth), which is the strategy this lane generates with, so a seed
// row's keys are its column names.
//
// The seed is `report/seed.json`. Every top-level key but `reports` is a base table, listed
// parents first (`products` before `sales`, which references it), and is inserted in file
// order so every foreign key holds: the views derive the report rows from them. `reports`
// is what the seam lanes (Java, Kotlin, Python) serve in place of the views, and is not
// used here.

using System.Text.Json;        // JsonValueKind
using System.Text.Json.Nodes;  // JsonNode / JsonObject / JsonArray
using Npgsql;

namespace MetaObjects.IntegrationTests.Api;

internal static class ReportFixture
{
    /// <summary>The one top-level key of seed.json that is not a base table.</summary>
    private const string SeedReportsKey = "reports";

    /// <summary>Execute the committed TypeScript-produced schema on a fresh container.</summary>
    public static async Task ProvisionSchemaAsync(string connString)
    {
        await using var c = new NpgsqlConnection(connString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = await File.ReadAllTextAsync(ApiContractCorpusPaths.ReportSchemaSql);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Insert every base table of the seed, in file order (parents first). The views are
    /// never seeded — they derive from the base tables, which is what makes this a
    /// full-stack lane. Values are SQL literals, as the TypeScript lane writes them, so
    /// Postgres types each one by its column (`'2026-04-30'` into a DATE).
    /// </summary>
    public static async Task ApplySeedAsync(string connString, string seedPath)
    {
        var root = JsonNode.Parse(File.ReadAllText(seedPath)) as JsonObject
            ?? throw new InvalidOperationException($"{seedPath}: top-level must be an object");
        var tables = root.Where(kv => kv.Key != SeedReportsKey).ToList();
        if (tables.Count == 0)
            throw new InvalidOperationException($"{seedPath}: no base-table rows to seed");

        await using var c = new NpgsqlConnection(connString);
        await c.OpenAsync();

        foreach (var (table, rowsNode) in tables)
        {
            if (rowsNode is not JsonArray rows)
                throw new InvalidOperationException($"{seedPath}: '{table}' is not an array of rows");
            foreach (var rowNode in rows)
            {
                if (rowNode is not JsonObject row)
                    throw new InvalidOperationException($"{seedPath}: '{table}' has a row that is not an object");
                var colList = string.Join(", ", row.Select(kv => "\"" + kv.Key + "\""));
                var valueList = string.Join(", ", row.Select(kv => SqlLiteral(seedPath, table, kv.Key, kv.Value)));
                await using var ins = c.CreateCommand();
                ins.CommandText = $"INSERT INTO \"{table}\" ({colList}) VALUES ({valueList})";
                await ins.ExecuteNonQueryAsync();
            }

            // The seed writes explicit ids; move each identity past them.
            if (rows.Any(r => r is JsonObject o && o.ContainsKey("id")))
            {
                await using var bump = c.CreateCommand();
                bump.CommandText =
                    $"SELECT setval(pg_get_serial_sequence('{table}', 'id'), " +
                    $"COALESCE((SELECT MAX(id) FROM \"{table}\"), 1))";
                await bump.ExecuteScalarAsync();
            }
        }
    }

    /// <summary>A seed value as a SQL literal: NULL, a JSON number as written, TRUE/FALSE, or a quoted string.</summary>
    private static string SqlLiteral(string seedPath, string table, string column, JsonNode? v)
    {
        if (v is null) return "NULL";
        return v.GetValueKind() switch
        {
            JsonValueKind.Number => v.ToJsonString(),
            JsonValueKind.True => "TRUE",
            JsonValueKind.False => "FALSE",
            JsonValueKind.String => "'" + v.GetValue<string>().Replace("'", "''") + "'",
            _ => throw new InvalidOperationException(
                $"{seedPath}: '{table}.{column}' is not a scalar: {v.ToJsonString()}"),
        };
    }
}
