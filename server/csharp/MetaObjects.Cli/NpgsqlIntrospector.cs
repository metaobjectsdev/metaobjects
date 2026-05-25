// NpgsqlIntrospector — the production wiring of IPgIntrospector against a live
// Postgres connection. Keeps Npgsql dependencies pinned to the CLI project so the
// migration engine + ExpectedSchema stay provider-agnostic.

using MetaObjects.Codegen.Migrate;
using Npgsql;

namespace MetaObjects.Cli;

/// <summary>
/// <see cref="IPgIntrospector"/> backed by a single open <see cref="NpgsqlConnection"/>.
/// One instance per <c>meta migrate</c> invocation; disposed at the end.
/// </summary>
public sealed class NpgsqlIntrospector : IPgIntrospector, IAsyncDisposable
{
    private readonly NpgsqlConnection _conn;

    private NpgsqlIntrospector(NpgsqlConnection conn) => _conn = conn;

    /// <summary>Open a connection and return a ready-to-use introspector.
    /// Disposes the half-open connection if <see cref="NpgsqlConnection.OpenAsync()"/> throws.</summary>
    public static async Task<NpgsqlIntrospector> ConnectAsync(string connectionString)
    {
        var conn = new NpgsqlConnection(connectionString);
        try
        {
            await conn.OpenAsync();
            return new NpgsqlIntrospector(conn);
        }
        catch
        {
            await conn.DisposeAsync();
            throw;
        }
    }

    public async Task<IReadOnlyList<PgRow>> QueryAsync(string sql, params (string Name, object? Value)[] parameters)
    {
        await using var cmd = new NpgsqlCommand(sql, _conn);
        foreach (var (name, value) in parameters)
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        await using var reader = await cmd.ExecuteReaderAsync();

        var rows = new List<PgRow>();
        while (await reader.ReadAsync())
        {
            var dict = new Dictionary<string, object?>(reader.FieldCount, StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < reader.FieldCount; i++)
            {
                var name = reader.GetName(i);
                dict[name] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }
            rows.Add(new PgRow(dict));
        }
        return rows;
    }

    public ValueTask DisposeAsync() => _conn.DisposeAsync();
}
