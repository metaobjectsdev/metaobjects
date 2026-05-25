// PostgresContainer — a thin xUnit-friendly Testcontainers.PostgreSql wrapper.
// Lifecycle: start fresh container per scenario (slower but maximally isolated;
// shared-container with per-test schema namespacing is a future optimization).

using Testcontainers.PostgreSql;

namespace MetaObjects.IntegrationTests.Runner;

public sealed class PostgresContainer : IAsyncDisposable
{
    public string ConnectionString { get; }
    private readonly PostgreSqlContainer _container;

    private PostgresContainer(PostgreSqlContainer container)
    {
        _container = container;
        ConnectionString = container.GetConnectionString();
    }

    public static async Task<PostgresContainer> StartAsync()
    {
        var container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();
        await container.StartAsync();
        return new PostgresContainer(container);
    }

    public ValueTask DisposeAsync() => _container.DisposeAsync();
}
