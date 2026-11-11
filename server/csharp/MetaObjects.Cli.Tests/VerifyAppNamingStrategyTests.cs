using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// ADR-0058 Amendment 1 — an application registers its own naming strategy in its codegen runner
/// (codegen/Program.cs), which stock <c>dotnet meta</c> cannot see. <c>dotnet meta verify --codegen</c>
/// hands its gate to that runner, so it must not refuse the strategy's name before the hand-off:
/// stock verify read <c>.metaobjects/config.json</c> first, and a project whose config names an
/// app strategy failed verify while <c>dotnet meta gen</c> succeeded. A run with no hand-off still
/// refuses the unknown name, as the config read always has.
/// <para>
/// The codegen project here is a stand-in that reports its arguments: the point is the hand-off
/// happening, not what the runner does (EjectEndToEndTests runs a real one). One small build.
/// </para>
/// </summary>
public sealed class VerifyAppNamingStrategyTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-verify-appnaming-" + Guid.NewGuid().ToString("N"));

    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Patient", "children": [
        { "source.rdb": { "@table": "patients" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "firstName" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public VerifyAppNamingStrategyTests()
    {
        Directory.CreateDirectory(Path.Combine(_tmp, "metaobjects"));
        Directory.CreateDirectory(Path.Combine(_tmp, ".metaobjects"));
        Directory.CreateDirectory(Path.Combine(_tmp, "gen"));
        Directory.CreateDirectory(Path.Combine(_tmp, "prompts"));
        File.WriteAllText(Path.Combine(_tmp, "metaobjects", "meta.acme.json"), Model);
        File.WriteAllText(Path.Combine(_tmp, ".metaobjects", "config.json"),
            """{ "schema_version": 1, "naming": { "columns": "acme-app-columns" } }""");
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private void WriteStandInRunner()
    {
        var codegen = Path.Combine(_tmp, "codegen");
        Directory.CreateDirectory(codegen);
        File.WriteAllText(Path.Combine(codegen, "Codegen.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net8.0</TargetFramework>
                <ImplicitUsings>enable</ImplicitUsings>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(codegen, "Generators.cs"), "internal static class Generators { }\n");
        File.WriteAllText(Path.Combine(codegen, "Program.cs"),
            "Console.WriteLine(\"stand-in runner: \" + string.Join(' ', args));\nreturn 0;\n");
    }

    [Fact]
    public void Verify_codegen_hands_off_before_it_reads_an_app_naming_strategy()
    {
        WriteStandInRunner();

        var (exit, stdout, stderr) = CliProcess.Run(_tmp, "verify", "--codegen", "--out", "gen");

        Assert.Contains("stand-in runner: verify --codegen --out", stdout);
        Assert.DoesNotContain("acme-app-columns", stderr);
        Assert.True(exit == 0, $"exit {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    [Fact]
    public void Verify_with_no_hand_off_still_refuses_the_unknown_name()
    {
        var (exit, stdout, stderr) = CliProcess.Run(_tmp, "verify", "--templates", "--prompts", "prompts");

        Assert.Equal(2, exit);
        Assert.Contains("\"naming.columns\" names \"acme-app-columns\"", stderr);
        Assert.DoesNotContain("stand-in runner", stdout);
    }

    // The --templates and --db gates run in THIS process after the hand-off, and this process never
    // registered the strategy: refused as the config read refuses it (exit 2, the standard message,
    // and why), never an unhandled exception from the first name a gate resolves.
    [Theory]
    [InlineData("--templates", "--prompts", "prompts")]
    [InlineData("--db")]
    public void A_gate_this_process_runs_refuses_the_app_strategy_cleanly_after_the_hand_off(params string[] gate)
    {
        WriteStandInRunner();

        var (exit, stdout, stderr) = CliProcess.Run(_tmp, ["verify", "--codegen", "--out", "gen", .. gate]);

        Assert.Contains("stand-in runner: verify --codegen --out", stdout);
        Assert.Equal(2, exit);
        Assert.Contains("\"naming.columns\" names \"acme-app-columns\"", stderr);
        Assert.Contains("run in this process", stderr);
        Assert.DoesNotContain("Unhandled exception", stderr);
    }
}
