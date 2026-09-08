using System.Diagnostics;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// Drives the BUILT <c>dotnet meta</c> assembly as a subprocess, so a test exercises
/// Program.cs's real Main and argument parsing rather than a helper method reachable
/// in-process. Top-level statements compile to a name no test assembly can reference,
/// so this is the only way to assert on the CLI's own exit code.
/// </summary>
internal static class CliProcess
{
    /// <summary>Runs the actual built `dotnet meta` assembly as a subprocess, cwd
    /// pinned to <paramref name="workingDir"/>, so the test exercises Program.cs's
    /// real Main/argument-parsing rather than any method reachable in-process.</summary>
    internal static (int ExitCode, string Stdout, string Stderr) Run(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(ResolveCliDll());
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("failed to start dotnet");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        return (proc.ExitCode, stdout, stderr);
    }

    /// <summary>Locates the MetaObjects.Cli build output next to this test
    /// assembly's own build output — both projects share the same Configuration
    /// and TargetFramework (net8.0), and MetaObjects.Cli.Tests already builds
    /// MetaObjects.Cli as a project reference, so the dll is guaranteed present
    /// by the time `dotnet test` starts running tests.</summary>
    private static string ResolveCliDll()
    {
        var testsProjectDir = new DirectoryInfo(AppContext.BaseDirectory);
        while (testsProjectDir is not null &&
               !File.Exists(Path.Combine(testsProjectDir.FullName, "MetaObjects.Cli.Tests.csproj")))
            testsProjectDir = testsProjectDir.Parent;
        if (testsProjectDir is null)
            throw new InvalidOperationException(
                "could not locate MetaObjects.Cli.Tests.csproj by walking up from " + AppContext.BaseDirectory);

        var relSuffix = Path.GetRelativePath(testsProjectDir.FullName, AppContext.BaseDirectory);
        var dll = Path.Combine(testsProjectDir.Parent!.FullName, "MetaObjects.Cli", relSuffix, "MetaObjects.Cli.dll");
        if (!File.Exists(dll))
            throw new FileNotFoundException(
                $"expected the MetaObjects.Cli build output at {dll} (built automatically as a project " +
                "reference of MetaObjects.Cli.Tests)", dll);
        return dll;
    }
}
