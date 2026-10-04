// ReportFixture — schema provisioning + seed for the FR-044 report api-contract
// GENERATED lane.
//
// The schema is NOT written here. View SQL is produced by TypeScript only (ADR-0015), so
// this lane executes the committed, TypeScript-produced, drift-checked artifact
// `report/schema.postgres.sql` verbatim: the `invoices` table and the three views the
// served reports read. That artifact carries LITERAL column naming (amountCents,
// issuedOnMonth), which is the strategy this lane generates with.
//
// The seed is `report/seed.json`. Only its `invoices` half is inserted: the views derive
// the report rows from it. Its `reports` half is what the seam lanes (Java, Kotlin, Python)
// serve in place of the views, and is not used here.

using System.Globalization;
using System.Text.Json;        // JsonValueKind
using System.Text.Json.Nodes;  // JsonNode / JsonObject / JsonArray
using Npgsql;

namespace MetaObjects.IntegrationTests.Api;

internal static class ReportFixture
{
    private static readonly string[] InvoiceCols = { "id", "reference", "status", "amountCents", "issuedOn" };

    // The one DATE column: bound as a DateOnly so Npgsql sends a date, not text.
    private const string DateCol = "issuedOn";

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
    /// Insert the seed's `invoices`. The views are never seeded — they derive from
    /// `invoices`, which is what makes this a full-stack lane.
    /// </summary>
    public static async Task ApplySeedAsync(string connString, string seedPath)
    {
        var root = JsonNode.Parse(File.ReadAllText(seedPath)) as JsonObject
            ?? throw new InvalidOperationException($"{seedPath}: top-level must be an object");
        if (root["invoices"] is not JsonArray rows || rows.Count == 0)
            throw new InvalidOperationException($"{seedPath}: no `invoices` rows to seed");

        await using var c = new NpgsqlConnection(connString);
        await c.OpenAsync();

        var colList = string.Join(", ", InvoiceCols.Select(col => "\"" + col + "\""));
        var paramList = string.Join(", ", InvoiceCols.Select((_, i) => "@p" + i));
        foreach (var rowNode in rows)
        {
            if (rowNode is not JsonObject row) continue;
            await using var ins = c.CreateCommand();
            ins.CommandText = $"INSERT INTO \"invoices\" ({colList}) VALUES ({paramList})";
            for (int i = 0; i < InvoiceCols.Length; i++)
            {
                var v = row[InvoiceCols[i]];
                object val = v is null ? DBNull.Value
                    : InvoiceCols[i] == DateCol
                        ? DateOnly.ParseExact(v.GetValue<string>(), "yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : v.GetValueKind() == JsonValueKind.Number ? v.GetValue<long>()
                    : v.GetValue<string>();
                ins.Parameters.AddWithValue("@p" + i, val);
            }
            await ins.ExecuteNonQueryAsync();
        }

        await using var bump = c.CreateCommand();
        bump.CommandText =
            "SELECT setval(pg_get_serial_sequence('invoices', 'id'), " +
            "COALESCE((SELECT MAX(id) FROM \"invoices\"), 1))";
        await bump.ExecuteScalarAsync();
    }
}
