using System.Diagnostics;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// Proves the <c>&lt;metadataDir&gt;</c>-optional fallback (Program.cs's
/// <c>ResolveMetadataDirOrExit</c>) is actually WIRED into <c>dotnet meta gen</c>,
/// not merely defined and unit-tested in isolation. A resolver function that
/// nothing calls is exactly the gap the Python port shipped first (see the
/// SourceResolutionConformanceTests header + task-4-report.md) — the only way to
/// catch that class of bug is to drive the real command entry point (the built
/// CLI assembly, invoked as a subprocess) rather than calling a helper method
/// directly, since a top-level-statement local function compiles to a name this
/// test assembly cannot reference at all.
/// </summary>
public sealed class MetadataDirFallbackTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-fallback-" + Guid.NewGuid().ToString("N"));

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Gen_with_no_positional_metadataDir_resolves_the_declared_source_and_generates()
    {
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Metadata);
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "sources": [ { "path": "model" } ] }""");

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, stdout, stderr) = RunCli(_tmp, "gen", "--out", outDir, "--namespace", "Acme.Generated");

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.True(File.Exists(Path.Combine(outDir, "Subscriber.g.cs")), stdout + stderr);
    }

    [Fact]
    public void Gen_with_no_positional_metadataDir_and_nothing_to_resolve_reports_the_ladders_own_error()
    {
        // Before the ladder was wired, an omitted positional always produced the
        // generic "usage: ..." 2-exit, regardless of what (if anything) the cwd
        // contained. Once wired, an empty project reaches SourceResolver and
        // fails with ITS OWN diagnostic — proof the omitted case is actually
        // being routed through resolution rather than still failing the old way.
        Directory.CreateDirectory(_tmp);

        var (exitCode, _, stderr) = RunCli(_tmp, "gen", "--out", Path.Combine(_tmp, "generated"), "--namespace", "X");

        Assert.Equal(2, exitCode);
        Assert.Contains("ERR_COLLECTION_NOT_FOUND", stderr);
    }

    [Fact]
    public void Gen_with_no_positional_metadataDir_and_multiple_declared_sources_refuses_rather_than_picking_one()
    {
        var aDir = Path.Combine(_tmp, "a");
        var bDir = Path.Combine(_tmp, "b");
        Directory.CreateDirectory(aDir);
        Directory.CreateDirectory(bDir);
        File.WriteAllText(Path.Combine(aDir, "meta.a.json"), """{ "metadata.root": { "children": [] } }""");
        File.WriteAllText(Path.Combine(bDir, "meta.b.json"), """{ "metadata.root": { "children": [] } }""");
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "sources": [ { "path": "a" }, { "path": "b" } ] }""");

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, _, stderr) = RunCli(_tmp, "gen", "--out", outDir, "--namespace", "X");

        Assert.Equal(2, exitCode);
        Assert.Contains("2 metadata sources", stderr);
        Assert.False(Directory.Exists(outDir), "must not silently generate from just one of several declared sources");
    }

    [Fact]
    public void Gen_with_no_positional_metadataDir_and_a_single_FILE_source_refuses_clearly()
    {
        // Before this fix, a single declared `path` source resolving to a FILE
        // (rather than a directory) was handed straight to MetaDataLoader.FromDirectory,
        // which fails deep inside DirectorySource with an opaque, uncoded ERR_UNKNOWN —
        // never naming the actual limit (this CLI's loader takes only a directory).
        var vendorDir = Path.Combine(_tmp, "vendor");
        Directory.CreateDirectory(vendorDir);
        File.WriteAllText(Path.Combine(vendorDir, "meta.catalog.json"), """{ "metadata.root": { "children": [] } }""");
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "sources": [ { "path": "vendor/meta.catalog.json" } ] }""");

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, _, stderr) = RunCli(_tmp, "gen", "--out", outDir, "--namespace", "X");

        Assert.Equal(2, exitCode);
        Assert.Contains("is a FILE", stderr);
        Assert.DoesNotContain("ERR_UNKNOWN", stderr);
        Assert.False(Directory.Exists(outDir));
    }

    [Fact]
    public void Gen_with_an_explicit_positional_metadataDir_is_unaffected()
    {
        // The explicit-argument path must stay byte-identical: no .metaobjects/
        // config.json in play at all, yet generation still succeeds because the
        // ladder is never consulted when the caller already named a directory.
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Metadata);

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, stdout, stderr) = RunCli(_tmp, "gen", modelDir, "--out", outDir, "--namespace", "Acme.Generated");

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.True(File.Exists(Path.Combine(outDir, "Subscriber.g.cs")), stdout + stderr);
    }

    /// <summary>Runs the actual built `dotnet meta` assembly as a subprocess, cwd
    /// pinned to <paramref name="workingDir"/>, so the test exercises Program.cs's
    /// real Main/argument-parsing rather than any method reachable in-process.</summary>
    private static (int ExitCode, string Stdout, string Stderr) RunCli(string workingDir, params string[] args)
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
