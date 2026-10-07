using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// The command-line surface every port's CLI shares with the Node <c>meta</c>: the three
/// version spellings, <c>--help</c> as output rather than an error, and an unknown flag
/// refused by name with the command's valid flags listed (exit 2). <c>gen</c> and
/// <c>docs</c> used to drop an unknown flag and exit 0 as though it had been honoured.
/// Driven through the built assembly, because Program.cs's argument parsing is
/// top-level statements no test can call directly.
/// </summary>
public sealed class CliSurfaceTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-surface-" + Guid.NewGuid().ToString("N"));

    public CliSurfaceTests() => Directory.CreateDirectory(_tmp);

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Theory]
    [InlineData("--version")]
    [InlineData("-v")]
    [InlineData("-V")]
    public void A_version_flag_prints_the_bare_version_and_exits_0(string flag)
    {
        var (exit, stdout, stderr) = CliProcess.Run(_tmp, flag);
        Assert.True(exit == 0, $"exit={exit}\nstderr={stderr}");
        Assert.Matches(@"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$", stdout.Trim());
    }

    [Fact]
    public void Help_is_output_on_stdout_and_exits_0()
    {
        var (exit, stdout, _) = CliProcess.Run(_tmp, "--help");
        Assert.Equal(0, exit);
        Assert.Contains("usage: dotnet meta <command>", stdout);
        // --namespace defaults (GenCommand.DefaultNamespace); the banner must not show it as required.
        Assert.Contains("--out <dir> [--namespace <ns>]", stdout);
    }

    [Theory]
    [InlineData("gen", "usage: dotnet meta gen")]
    [InlineData("verify", "usage: dotnet meta verify")]
    [InlineData("docs", "usage: dotnet meta docs")]
    [InlineData("fmt", "usage: dotnet meta fmt")]
    [InlineData("eject", "usage: dotnet meta eject")]
    public void A_command_help_prints_that_commands_usage_and_exits_0(string command, string expected)
    {
        var (exit, stdout, _) = CliProcess.Run(_tmp, command, "--help");
        Assert.Equal(0, exit);
        Assert.Contains(expected, stdout);
    }

    [Theory]
    [InlineData("gen", "--generators", "x", "--out", "o")]
    [InlineData("docs", "--out", "o", "x")]
    [InlineData("verify", "x")]
    [InlineData("fmt")]
    [InlineData("eject", "entity")]
    public void An_unknown_flag_is_refused_by_name_with_the_valid_flags_listed(string command, params string[] rest)
    {
        var (exit, _, stderr) = CliProcess.Run(_tmp, [command, .. rest, "--bogus"]);
        Assert.Equal(2, exit);
        Assert.Contains($"unknown flag --bogus for `dotnet meta {command}`. Valid flags: ", stderr);
    }

    [Fact]
    public void A_value_flag_with_no_value_says_so_rather_than_calling_it_unknown()
    {
        var (exit, _, stderr) = CliProcess.Run(_tmp, "gen", "x", "--out");
        Assert.Equal(2, exit);
        Assert.Contains("--out needs a value", stderr);
    }
}
