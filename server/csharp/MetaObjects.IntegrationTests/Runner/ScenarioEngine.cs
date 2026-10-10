// ScenarioEngine — the database engine a query scenario runs against. Postgres is the
// reference; SQLite and MySQL are the other engines the FR-044 report scenarios run on in C#.

using System.Data.Common;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using MySqlConnector;
using Npgsql;

namespace MetaObjects.IntegrationTests.Runner;

public enum ScenarioEngine
{
    Postgres,
    Sqlite,
    MySql,
}

/// <summary>
/// The engine-keyed facts of the corpus lanes live HERE, not in per-caller switches: one
/// provider choice, one connection factory, one script executor, one identifier quote. A
/// fourth engine means one more arm in each of these switches (and the Postgres-default arm
/// is a loud TODO there), not a hunt through the fixture, runner and server factory.
/// </summary>
public static class ScenarioEngineExtensions
{
    /// <summary>The engine's name as the corpus spells it (the key of a <c>seed-data-engine</c> entry).</summary>
    public static string Name(this ScenarioEngine engine) => engine switch
    {
        ScenarioEngine.Postgres => "postgres",
        ScenarioEngine.Sqlite => "sqlite",
        ScenarioEngine.MySql => "mysql",
        _ => throw new ArgumentOutOfRangeException(nameof(engine), engine, null),
    };

    /// <summary>The identifier quote seeds and inserts use: MySQL backticks, everything else the corpus' double quotes.</summary>
    public static string Quote(this ScenarioEngine engine) =>
        engine == ScenarioEngine.MySql ? "`" : "\"";

    /// <summary>The server version Pomelo generates against. Keep in step with the mysql:8.4 image MySqlDatabase starts.</summary>
    public static readonly Version MySqlProviderVersion = new(8, 4, 0);

    /// <summary>Point this engine's EF Core provider at <paramref name="connString"/> (mutates and returns the builder).</summary>
    public static DbContextOptionsBuilder UseEngine(this DbContextOptionsBuilder builder, ScenarioEngine engine, string connString) =>
        engine switch
        {
            ScenarioEngine.Sqlite => builder.UseSqlite(connString),
            ScenarioEngine.MySql => builder.UseMySql(connString, new MySqlServerVersion(MySqlProviderVersion)),
            _ => builder.UseNpgsql(connString),
        };

    /// <summary>Open this engine's ADO.NET connection. Callers treat it as the provider-neutral <see cref="DbConnection"/>.</summary>
    public static async Task<DbConnection> OpenConnectionAsync(this ScenarioEngine engine, string connString)
    {
        DbConnection conn = engine switch
        {
            ScenarioEngine.Sqlite => new SqliteConnection(connString),
            ScenarioEngine.MySql => new MySqlConnection(connString),
            _ => new NpgsqlConnection(connString),
        };
        await conn.OpenAsync();
        return conn;
    }

    /// <summary>Execute one whole SQL script (schema artifact or seed) on a fresh connection of this engine.</summary>
    public static async Task ExecuteScriptAsync(this ScenarioEngine engine, string connString, string sql)
    {
        await using var conn = await engine.OpenConnectionAsync(connString);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }
}

public static partial class MySqlSeed
{
    [GeneratedRegex(@"'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z'")]
    private static partial Regex UtcInstant();

    /// <summary>
    /// Postgres-quoted seed SQL to MySQL. Walks the text once so a double quote INSIDE a
    /// single-quoted string (a JSON payload) is left alone and only a double-quoted identifier
    /// becomes a backtick one; a UTC instant literal loses its <c>Z</c> (a DATETIME holds the UTC
    /// wall clock). ANSI_QUOTES stays off: it would change how the view bodies parse.
    /// </summary>
    public static string FromPostgres(string seed)
    {
        var sb = new StringBuilder(seed.Length);
        bool inString = false, inIdent = false;
        for (var i = 0; i < seed.Length; i++)
        {
            var c = seed[i];
            if (inString)
            {
                sb.Append(c);
                if (c == '\'')
                {
                    if (i + 1 < seed.Length && seed[i + 1] == '\'') { sb.Append('\''); i++; }
                    else inString = false;
                }
            }
            else if (inIdent)
            {
                if (c == '"') { sb.Append('`'); inIdent = false; } else sb.Append(c);
            }
            else if (c == '\'') { inString = true; sb.Append(c); }
            else if (c == '"') { inIdent = true; sb.Append('`'); }
            else sb.Append(c);
        }
        return UtcInstant().Replace(sb.ToString(), "'$1'");
    }
}
