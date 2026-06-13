using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port api-docs LAYOUT conformance gate — the C# half (Phase 0 of the
/// cross-port SDK-docs plan, docs/superpowers/plans/2026-06-13-cross-port-sdk-docs.md).
///
/// The shared contract is <c>fixtures/conformance/api-docs-cross-port/expected-paths.json</c>,
/// which already declares the <c>api/csharp</c> surface (<c>apiCsharpSubDir</c>, and per-unit
/// <c>apiCsharpPath</c> / <c>apiCsharpToModel</c>). The TS and Java ports assert their own
/// surfaces against this manifest; this is the analogous C# assertion.
///
/// Unlike the Java reference test (which builds its api model in-process), this drives the
/// C# port END-TO-END through the real CLI: <c>dotnet meta docs &lt;input-dir&gt; --out &lt;tmp&gt;</c>.
/// For every manifest unit it then asserts that <c>&lt;tmp&gt;/&lt;apiCsharpPath&gt;</c> exists and
/// carries the contract model back-link <c>**Model / metadata:** [&lt;node&gt;](&lt;apiCsharpToModel&gt;)</c>.
///
/// This is EXPECTED TO FAIL today: the C# CLI has no <c>docs</c> command (Program.cs dispatches
/// only gen/verify/agent-docs), so the run emits no <c>api/csharp</c> files and the per-unit
/// file-existence assertion fails. That red is the intended Phase-0 signal; the test turns green
/// once the C# <c>docs</c> command + <c>api/csharp</c> surface ship. The manifest is the single
/// source of truth — a future divergence is a real cross-port finding, not a reason to weaken this.
/// </summary>
public sealed class ApiDocsCrossPortConformanceTests
{
    private const string CaseName = "api-docs-cross-port";

    /// <summary>Walk upward from the test assembly to the repo root (contains <c>fixtures/</c> + <c>server/</c>).</summary>
    private static string RepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !(Directory.Exists(Path.Combine(dir, "fixtures")) &&
                 Directory.Exists(Path.Combine(dir, "server"))))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException(
                "could not locate repo root (a dir containing both fixtures/ and server/) walking up from "
                + AppContext.BaseDirectory);
        return dir;
    }

    private static string CaseDir() => Path.Combine(RepoRoot(), "fixtures", "conformance", CaseName);

    /// <summary>
    /// Locate the built <c>MetaObjects.Cli.dll</c> (the `dotnet meta` host). The Cli project
    /// is NOT a reference of this test project, so we exec its build output directly rather
    /// than rebuild it per test run (which, under concurrent MSBuild, can dwarf the run).
    /// </summary>
    private static string CliDll()
    {
        var cliBase = Path.Combine(RepoRoot(), "server", "csharp", "MetaObjects.Cli", "bin");
        if (Directory.Exists(cliBase))
        {
            // Prefer Debug (what `dotnet build`/`dotnet test` produce); fall back to any config.
            var dll = Directory.EnumerateFiles(cliBase, "MetaObjects.Cli.dll", SearchOption.AllDirectories)
                .OrderByDescending(p => p.Contains($"{Path.DirectorySeparatorChar}Debug{Path.DirectorySeparatorChar}"))
                .ThenByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (dll is not null) return dll;
        }
        throw new InvalidOperationException(
            "MetaObjects.Cli.dll was not found under " + cliBase +
            " — build the CLI first (e.g. `dotnet build server/csharp/MetaObjects.Cli`).");
    }

    /// <summary>Run the C# CLI end-to-end: <c>dotnet meta docs &lt;inputDir&gt; --out &lt;tmp&gt;</c> (via the built dll).</summary>
    private static (int ExitCode, string Stdout, string Stderr) RunDocsCli(string inputDir, string outDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "dotnet",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(CliDll());
        psi.ArgumentList.Add("docs");
        psi.ArgumentList.Add(inputDir);
        psi.ArgumentList.Add("--out");
        psi.ArgumentList.Add(outDir);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("failed to start the C# CLI (`dotnet meta docs`)");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        return (proc.ExitCode, stdout, stderr);
    }

    [Fact]
    public void CsharpApiDocsSurface_MatchesTheSharedManifest()
    {
        // ---- read the shared contract as a tree (unknown fields are fine) ----
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(CaseDir(), "expected-paths.json")));
        var root = manifest.RootElement;
        Assert.Equal("package", root.GetProperty("layout").GetString());
        var apiCsharpSubDir = root.GetProperty("apiCsharpSubDir").GetString();
        Assert.Equal("api/csharp", apiCsharpSubDir);

        var inputDir = Path.Combine(CaseDir(), "input");
        var outDir = Path.Combine(Path.GetTempPath(), "meta-api-docs-csharp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outDir);

        try
        {
            // ---- drive the C# docs entrypoint end-to-end ----
            var (exitCode, stdout, stderr) = RunDocsCli(inputDir, outDir);

            // ---- per-unit: the api/csharp page must exist AND carry the model back-link ----
            foreach (var unit in root.GetProperty("units").EnumerateArray())
            {
                var node = unit.GetProperty("node").GetString()!;
                var apiCsharpPath = unit.GetProperty("apiCsharpPath").GetString()!;
                var apiCsharpToModel = unit.GetProperty("apiCsharpToModel").GetString()!;

                var pageFile = Path.Combine(outDir, apiCsharpPath.Replace('/', Path.DirectorySeparatorChar));

                Assert.True(File.Exists(pageFile),
                    $"C# api-docs surface is missing the page for '{node}'.\n" +
                    $"  expected file: {apiCsharpPath} (under the --out dir)\n" +
                    $"  the C# CLI has no `docs` command yet, so `dotnet meta docs` produced no api/csharp output.\n" +
                    $"  CLI exit code: {exitCode}\n" +
                    $"  CLI stdout: {stdout.Trim()}\n" +
                    $"  CLI stderr: {stderr.Trim()}");

                var page = File.ReadAllText(pageFile);
                var expectedBackLink = $"**Model / metadata:** [{node}]({apiCsharpToModel})";
                Assert.True(page.Contains(expectedBackLink),
                    $"rendered api/csharp page for '{node}' must carry the contract back-link:\n  " +
                    $"{expectedBackLink}\nactual page:\n{page}");
            }
        }
        finally
        {
            try { Directory.Delete(outDir, recursive: true); } catch { /* best effort */ }
        }
    }
}
