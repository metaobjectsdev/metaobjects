// A killed process removes its container.
//
// Public behaviour: once a process that started a helper container dies without running any
// teardown, Docker stops listing that container. The oracle is Docker itself, queried from outside
// the killed process. A helper that labels nothing, or a reaper that accepts the label and removes
// nothing, such as the Ryuk below Testcontainers 4.0 on Docker 29, fails on the deadline.

using System.Diagnostics;
using System.Text.RegularExpressions;
using MetaObjects.IntegrationTests.Runner;
using Npgsql;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class ReaperKillTests
{
    private static readonly TimeSpan ChildReady = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RemovalBound = TimeSpan.FromSeconds(45);

    // The killed process: it starts a real helper container, reports the port and waits. This is
    // the test assembly's entry point, which GenerateProgramFile=false leaves free.
    private static async Task Main()
    {
        var pg = await PostgresContainer.StartAsync();
        Console.WriteLine($"READY {new NpgsqlConnectionStringBuilder(pg.ConnectionString).Port}");
        await Task.Delay(TimeSpan.FromMinutes(10));
    }

    [Fact]
    public async Task Killed_process_removes_its_container()
    {
        var start = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true };
        start.ArgumentList.Add(typeof(ReaperKillTests).Assembly.Location);
        start.Environment.Remove("METAOBJECTS_TEST_PG_URL");
        using var child = Process.Start(start)!;
        var container = "";
        try
        {
            var port = await AwaitPortAsync(child);
            container = await DockerAsync("ps", "--filter", $"publish={port}/tcp", "--format", "{{.Names}}");
            Assert.NotEqual("", container);

            child.Kill();
            Assert.True(child.WaitForExit(30_000), "the child outlived SIGKILL");

            var deadline = DateTime.UtcNow + RemovalBound;
            while (await ExistsAsync(container) && DateTime.UtcNow < deadline)
            {
                await Task.Delay(250);
            }
            Assert.False(await ExistsAsync(container), $"{container} outlived its killed process");
        }
        finally
        {
            child.Kill();
            if (container != "") await DockerAsync("rm", "-f", "-v", container);
        }
    }

    private static async Task<string> AwaitPortAsync(Process child)
    {
        using var timeout = new CancellationTokenSource(ChildReady);
        while (await child.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
        {
            var ready = Regex.Match(line, @"^READY (\d+)$");
            if (ready.Success) return ready.Groups[1].Value;
        }
        throw new InvalidOperationException("reaper child exited without reporting its container");
    }

    private static async Task<bool> ExistsAsync(string container) =>
        await DockerAsync("ps", "-a", "--filter", $"name=^{container}$", "--format", "{{.Names}}") != "";

    private static async Task<string> DockerAsync(params string[] args)
    {
        var start = new ProcessStartInfo("docker") { RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var docker = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var output = docker.StandardOutput.ReadToEndAsync(timeout.Token);
        var error = docker.StandardError.ReadToEndAsync(timeout.Token);
        await docker.WaitForExitAsync(timeout.Token);
        Assert.True(docker.ExitCode == 0, $"docker {string.Join(' ', args)}: {await error}");
        return (await output).Trim();
    }
}
