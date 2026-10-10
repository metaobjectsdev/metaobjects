// MySqlDatabase — a fresh, isolated MySQL database for one scenario.
//
// Two modes, mirroring PostgresContainer:
//   1. Existing server: METAOBJECTS_TEST_MYSQL_URL names a running MySQL as an ADO.NET
//      connection string (an admin login). A uniquely-named database is created per
//      instance and dropped on dispose.
//   2. Per-container (default): start a mysql:8.4 Testcontainers container.

using MySqlConnector;
using Testcontainers.MySql;

namespace MetaObjects.IntegrationTests.Runner;

public sealed class MySqlDatabase : IAsyncDisposable
{
    private const string ExistingServerEnv = "METAOBJECTS_TEST_MYSQL_URL";

    public string ConnectionString { get; }

    private readonly MySqlContainer? _container;   // null when an existing server is used
    private readonly string? _adminConnectionString;
    private readonly string? _createdDb;

    private MySqlDatabase(MySqlContainer container)
    {
        _container = container;
        ConnectionString = container.GetConnectionString();
    }

    private MySqlDatabase(string connectionString, string adminConnectionString, string createdDb)
    {
        ConnectionString = connectionString;
        _adminConnectionString = adminConnectionString;
        _createdDb = createdDb;
    }

    public static async Task<MySqlDatabase> StartAsync()
    {
        var existing = Environment.GetEnvironmentVariable(ExistingServerEnv);
        if (!string.IsNullOrWhiteSpace(existing))
        {
            var createdDb = "mo_test_cs_" + Guid.NewGuid().ToString("N");
            await using (var admin = new MySqlConnection(existing))
            {
                await admin.OpenAsync();
                // Generated database name — no user input; safe to inline.
                await using var cmd = new MySqlCommand($"CREATE DATABASE `{createdDb}`", admin);
                await cmd.ExecuteNonQueryAsync();
            }
            var scenario = new MySqlConnectionStringBuilder(existing) { Database = createdDb };
            return new MySqlDatabase(scenario.ConnectionString, existing, createdDb);
        }

        var container = new MySqlBuilder().WithImage("mysql:8.4").Build();
        await container.StartAsync();
        return new MySqlDatabase(container);
    }

    public async ValueTask DisposeAsync()
    {
        if (_container is not null)
        {
            await _container.DisposeAsync();
            return;
        }
        try
        {
            await using var admin = new MySqlConnection(_adminConnectionString);
            await admin.OpenAsync();
            await using var cmd = new MySqlCommand($"DROP DATABASE IF EXISTS `{_createdDb}`", admin);
            await cmd.ExecuteNonQueryAsync();
        }
        catch
        {
            // Best-effort cleanup.
        }
    }
}
