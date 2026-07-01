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
/// The C# <c>docs</c> command + <c>api/csharp</c> surface have SHIPPED (Program.cs dispatches
/// <c>docs</c> → <c>DocsCommand</c> → <c>CSharpApiDocsRenderer</c>), so this test PASSES. Because
/// it execs the CLI end-to-end, it requires <c>MetaObjects.Cli.dll</c> to be built first — a normal
/// full-solution build (or CI) does that; running <c>dotnet test</c> on THIS project in isolation
/// without first building the CLI will SKIP (see <see cref="FindCliDll"/>), never hard-fail. The
/// manifest is the single source of truth — a future divergence is a real cross-port finding, not a
/// reason to weaken this.
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
    /// Locate the built <c>MetaObjects.Cli.dll</c> (the `dotnet meta` host), or <c>null</c> if it
    /// has not been built. The Cli project is NOT a reference of this test project, so we exec its
    /// build output directly rather than rebuild it per test run (which, under concurrent MSBuild,
    /// can dwarf the run). A null result means the CLI was not built — the test skips rather than
    /// failing (an isolated <c>dotnet test</c> on this project alone does not build the CLI; a
    /// full-solution build or CI does).
    /// </summary>
    private static string? FindCliDll()
    {
        var cliBase = Path.Combine(RepoRoot(), "server", "csharp", "MetaObjects.Cli", "bin");
        if (!Directory.Exists(cliBase)) return null;
        // Prefer Debug (what `dotnet build`/`dotnet test` produce); fall back to any config.
        return Directory.EnumerateFiles(cliBase, "MetaObjects.Cli.dll", SearchOption.AllDirectories)
            .OrderByDescending(p => p.Contains($"{Path.DirectorySeparatorChar}Debug{Path.DirectorySeparatorChar}"))
            .ThenByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    /// <summary>Run the C# CLI end-to-end: <c>dotnet meta docs &lt;inputDir&gt; --out &lt;tmp&gt;</c> (via the built dll).</summary>
    private static (int ExitCode, string Stdout, string Stderr) RunDocsCli(string cliDll, string inputDir, string outDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "dotnet",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(cliDll);
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

        // The test execs the built CLI. If it hasn't been built (an isolated `dotnet test` on
        // this project alone doesn't build it), skip rather than hard-fail — CI + full-solution
        // builds always build the CLI, so the gate is real there.
        // Soft-skip when the CLI isn't built: an isolated `dotnet test` on this project alone
        // does not build MetaObjects.Cli, so there is nothing to exercise. CI runs this only
        // AFTER building the CLI (see conformance.yml), so the gate is real there. (xUnit 2.9's
        // dynamic Assert.Skip isn't enabled in this project; a visible console note + early
        // return is the low-dependency equivalent — never a hard failure for a missing build.)
        var cliDll = FindCliDll();
        if (cliDll is null)
        {
            Console.WriteLine(
                "[api-docs-cross-port] SKIP: MetaObjects.Cli.dll not built — build the CLI "
                + "(`dotnet build server/csharp/MetaObjects.Cli`) to exercise this gate.");
            return;
        }

        var inputDir = Path.Combine(CaseDir(), "input");
        var outDir = Path.Combine(Path.GetTempPath(), "meta-api-docs-csharp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outDir);

        try
        {
            // ---- drive the C# docs entrypoint end-to-end ----
            var (exitCode, stdout, stderr) = RunDocsCli(cliDll!, inputDir, outDir);

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
