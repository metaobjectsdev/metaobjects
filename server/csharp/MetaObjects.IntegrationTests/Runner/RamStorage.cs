// RamStorage — a test database keeps its data in RAM.
//
// Each database image declares a VOLUME for its data directory; a container started without a
// mount there gets an anonymous volume on disk. A size-capped tmpfs at that path keeps a
// throwaway database off the drives. Postgres durability is already off: the Testcontainers
// PostgreSql builder starts the server with fsync, synchronous_commit and full_page_writes off.
// The Testcontainers resource reaper (Ryuk) removes the containers of a run that dies before
// its dispose.

using Docker.DotNet.Models;

namespace MetaObjects.IntegrationTests.Runner;

internal static class RamStorage
{
    /// <summary>Upper bound for one database's data directory; tmpfs takes RAM only for what is written.</summary>
    public const string TmpfsSize = "2g";

    /// <summary>The VOLUME <c>postgres:16*</c> declares (<c>docker image inspect</c>).</summary>
    public const string Postgres16DataDir = "/var/lib/postgresql/data";

    /// <summary>The VOLUME <c>mysql:8*</c> declares (<c>docker image inspect</c>).</summary>
    public const string MySql8DataDir = "/var/lib/mysql";

    /// <summary>A create-parameter modifier mounting a size-capped tmpfs at <paramref name="path"/>.</summary>
    public static Action<CreateContainerParameters> Tmpfs(string path) => parameters =>
    {
        parameters.HostConfig ??= new HostConfig();
        parameters.HostConfig.Tmpfs ??= new Dictionary<string, string>();
        parameters.HostConfig.Tmpfs[path] = $"rw,size={TmpfsSize}";
    };
}
