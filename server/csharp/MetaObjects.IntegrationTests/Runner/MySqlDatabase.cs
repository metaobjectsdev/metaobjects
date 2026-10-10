// MySqlServer — one MySQL server shared by the MySQL test collection, and MySqlDatabase — a
// fresh, isolated database on it for one scenario.
//
// The server is, in order:
//   1. Existing server: METAOBJECTS_TEST_MYSQL_URL names a running MySQL as
//      mysql://user:pass@host:port/db (an admin login), the form the TypeScript suite reads.
//   2. Otherwise one mysql:8.4 Testcontainers container, started on first use and removed when
//      the collection finishes.
// Either way each scenario gets a uniquely-named database, dropped on dispose.

using MySqlConnector;
using Testcontainers.MySql;
using Xunit;

namespace MetaObjects.IntegrationTests.Runner;

public sealed class MySqlServer : IAsyncLifetime
{
    private const string ExistingServerEnv = "METAOBJECTS_TEST_MYSQL_URL";

    private readonly Lazy<Task<string>> _adminConnectionString;
    private MySqlContainer? _container;   // null until started, and when an existing server is used

    public MySqlServer()
    {
        _adminConnectionString = new Lazy<Task<string>>(StartAsync);
    }

    private async Task<string> StartAsync()
    {
        var existing = Environment.GetEnvironmentVariable(ExistingServerEnv);
        if (!string.IsNullOrWhiteSpace(existing)) return FromUrl(existing);

        _container = new MySqlBuilder().WithImage("mysql:8.4").WithUsername("root").Build();
        await _container.StartAsync();
        return _container.GetConnectionString();
    }

    private static string FromUrl(string url)
    {
        var uri = new Uri(url);
        var userInfo = uri.UserInfo.Split(':', 2);
        var builder = new MySqlConnectionStringBuilder
        {
            Server = uri.Host,
            Port = uri.Port == -1 ? 3306u : (uint)uri.Port,
            UserID = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "",
        };
        var database = uri.AbsolutePath.TrimStart('/');
        if (database.Length > 0) builder.Database = Uri.UnescapeDataString(database);
        return builder.ConnectionString;
    }

    /// <summary>A fresh, empty database on this server, dropped when the result is disposed.</summary>
    public async Task<MySqlDatabase> CreateDatabaseAsync()
    {
        var admin = await _adminConnectionString.Value;
        var createdDb = "mo_test_cs_" + Guid.NewGuid().ToString("N");
        await using (var connection = new MySqlConnection(admin))
        {
            await connection.OpenAsync();
            // Generated database name — no user input; safe to inline.
            await using var cmd = new MySqlCommand($"CREATE DATABASE `{createdDb}`", connection);
            await cmd.ExecuteNonQueryAsync();
        }
        var scenario = new MySqlConnectionStringBuilder(admin) { Database = createdDb };
        return new MySqlDatabase(scenario.ConnectionString, admin, createdDb);
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_container is not null) await _container.DisposeAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class MySqlCollection : ICollectionFixture<MySqlServer>
{
    public const string Name = "MySQL";
}

public sealed class MySqlDatabase : IAsyncDisposable
{
    public string ConnectionString { get; }

    private readonly string _adminConnectionString;
    private readonly string _createdDb;

    internal MySqlDatabase(string connectionString, string adminConnectionString, string createdDb)
    {
        ConnectionString = connectionString;
        _adminConnectionString = adminConnectionString;
        _createdDb = createdDb;
    }

    public async ValueTask DisposeAsync()
    {
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
