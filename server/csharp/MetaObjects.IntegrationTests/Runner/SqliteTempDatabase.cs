// SqliteTempDatabase — a throwaway SQLite file for one scenario, owned by the scenario.
//
// The teardown order IS the contract: Microsoft.Data.Sqlite pools connections, so the pools
// must be cleared BEFORE the file is deleted — otherwise a pooled connection holds the file
// and the next "fresh" scenario reads the previous scenario's rows. That step is easy to
// forget in a copy-paste, so it lives once.

using Microsoft.Data.Sqlite;

namespace MetaObjects.IntegrationTests.Runner;

internal sealed class SqliteTempDatabase : IDisposable
{
    /// <summary>Full path of the (not yet created) database file; the driver creates it on first use.</summary>
    public string FilePath { get; }

    public SqliteTempDatabase(string prefix) =>
        FilePath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"{prefix}{Guid.NewGuid():N}.db");

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (System.IO.File.Exists(FilePath)) System.IO.File.Delete(FilePath);
    }
}
