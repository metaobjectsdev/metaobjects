// PostgresContainer — obtain a fresh, isolated Postgres database per scenario.
//
// Two modes, mirroring the TS/Java/Kotlin/Python suites:
//   1. Shared sidecar (CI): if METAOBJECTS_TEST_PG_URL is set, connect to that
//      already-running Postgres and CREATE a uniquely-named database per instance
//      (dropping it on dispose). No container boot / image pull on the hot path —
//      the point of the shared `services: postgres` CI sidecar. Each scenario
//      still gets a pristine empty database, so isolation is identical to the
//      per-container path.
//   2. Per-container (local dev): with no env var, start a fresh
//      Testcontainers.PostgreSql container per scenario, exactly as before.

using Npgsql;
using Testcontainers.PostgreSql;

namespace MetaObjects.IntegrationTests.Runner;

public sealed class PostgresContainer : IAsyncDisposable
{
    // Env var naming the shared CI Postgres sidecar (admin URL). Unset = per-container fallback.
    private const string SharedPgUrlEnv = "METAOBJECTS_TEST_PG_URL";

    public string ConnectionString { get; }

    private readonly PostgreSqlContainer? _container;   // null in shared mode
    private readonly string? _adminConnString;          // set in shared mode
    private readonly string? _createdDb;                // set in shared mode

    private PostgresContainer(PostgreSqlContainer container)
    {
        _container = container;
        ConnectionString = container.GetConnectionString();
    }

    private PostgresContainer(string connectionString, string adminConnString, string createdDb)
    {
        ConnectionString = connectionString;
        _adminConnString = adminConnString;
        _createdDb = createdDb;
    }

    public static async Task<PostgresContainer> StartAsync()
    {
        var sharedUrl = Environment.GetEnvironmentVariable(SharedPgUrlEnv);
        if (!string.IsNullOrWhiteSpace(sharedUrl))
        {
            return await StartOnSharedAsync(sharedUrl);
        }

        var container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();
        await container.StartAsync();
        return new PostgresContainer(container);
    }

    // Shared-sidecar mode: CREATE a fresh, uniquely-named database on the
    // already-running Postgres named by the URL, and return a connection string
    // pointing at it. A dedicated database per scenario preserves the per-
    // container path's "pristine empty DB" isolation.
    private static async Task<PostgresContainer> StartOnSharedAsync(string adminUrl)
    {
        var uri = new Uri(adminUrl);
        var userInfo = uri.UserInfo.Split(':', 2);
        var user = userInfo.Length > 0 ? Uri.UnescapeDataString(userInfo[0]) : "postgres";
        var password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "";
        var port = uri.Port == -1 ? 5432 : uri.Port;
        var adminDb = uri.AbsolutePath.TrimStart('/');
        if (string.IsNullOrEmpty(adminDb)) adminDb = "postgres";

        var adminBuilder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = port,
            Username = user,
            Password = password,
            Database = adminDb,
        };
        var adminConnString = adminBuilder.ConnectionString;

        var createdDb = "mo_test_cs_" + Guid.NewGuid().ToString("N");
        await using (var admin = new NpgsqlConnection(adminConnString))
        {
            await admin.OpenAsync();
            // Generated database name — no user input; safe to inline.
            await using var cmd = new NpgsqlCommand($"CREATE DATABASE \"{createdDb}\"", admin);
            await cmd.ExecuteNonQueryAsync();
        }

        var scenarioBuilder = new NpgsqlConnectionStringBuilder(adminConnString) { Database = createdDb };
        return new PostgresContainer(scenarioBuilder.ConnectionString, adminConnString, createdDb);
    }

    public async ValueTask DisposeAsync()
    {
        if (_container != null)
        {
            await _container.DisposeAsync();
            return;
        }

        // Shared mode: drop the per-scenario database (best-effort).
        try
        {
            await using var admin = new NpgsqlConnection(_adminConnString);
            await admin.OpenAsync();
            await using var cmd = new NpgsqlCommand(
                $"DROP DATABASE IF EXISTS \"{_createdDb}\" WITH (FORCE)", admin);
            await cmd.ExecuteNonQueryAsync();
        }
        catch
        {
            // Best-effort cleanup.
        }
    }
}
