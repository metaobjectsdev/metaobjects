using System.Diagnostics;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta gen --column-naming</c> selects how a field with no explicit
/// <c>@column</c> becomes a physical column name.
///
/// <para>The strategy already existed — <c>GenConfig.ColumnNamingStrategy</c>, honoured by
/// every C# generator — but the CLI never set it, so a <c>dotnet meta gen</c> adopter was
/// pinned to <c>Literal</c> with no way out. That is a real break rather than a
/// preference: schema migrations are Node-owned (ADR-0015) and <c>meta migrate</c>
/// defaults to <c>snake_case</c>, so any multi-word field produced an EF entity mapping
/// <c>[Column("createdAt")]</c> against a database column <c>created_at</c>.</para>
///
/// <para>Driven through the built CLI as a subprocess, not by calling
/// <c>GenCommand.Run</c>: the defect was precisely that the flag never reached the
/// config, and only the real entry point can prove the wiring (same reason as
/// <see cref="MetadataDirFallbackTests"/>).</para>
/// </summary>
public sealed class ColumnNamingFlagTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-colnaming-" + Guid.NewGuid().ToString("N"));

    // `createdAt` has a case boundary; `purposeCode` carries an explicit @column that is
    // deliberately NOT its snake_case, so "the strategy ran" and "@column won" stay distinguishable.
    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "createdAt" } },
        { "field.string": { "name": "purposeCode", "@column": "reason" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private string MetaDir => Path.Combine(_tmp, "metaobjects");

    public ColumnNamingFlagTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private string GenerateWith(params string[] extraArgs)
    {
        var outDir = Path.Combine(_tmp, "generated-" + Guid.NewGuid().ToString("N"));
        var args = new List<string> { "gen", MetaDir, "--out", outDir, "--namespace", "Acme.Generated" };
        args.AddRange(extraArgs);
        var (exit, stdout, stderr) = RunCli(_tmp, args.ToArray());
        Assert.True(exit == 0, $"exit={exit}\n{stdout}{stderr}");
        return File.ReadAllText(Path.Combine(outDir, "Subscriber.g.cs"));
    }

    [Fact]
    public void Default_is_literal_unchanged()
    {
        // §A6 (task 4) — [Column] references SubscriberNames.CreatedAtColumn, whose
        // VALUE is still the literal-strategy "createdAt" (the constant's underlying
        // value, checked at the source below).
        var src = GenerateWith();
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", src);
    }

    [Fact]
    public void Snake_case_maps_the_field_name_to_a_snake_case_column()
    {
        var src = GenerateWith("--column-naming", "snake_case");
        Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", src);
        Assert.DoesNotContain("[Column(\"createdAt\")]", src);
    }

    [Fact]
    public void An_explicit_column_attr_wins_over_any_strategy()
    {
        foreach (var src in new[] { GenerateWith(), GenerateWith("--column-naming", "snake_case") })
        {
            Assert.Contains("[Column(SubscriberNames.PurposeCodeColumn)]", src);
            Assert.DoesNotContain("purpose_code", src);
        }
    }

    [Fact]
    public void An_unknown_strategy_is_a_usage_error_naming_the_valid_values()
    {
        var outDir = Path.Combine(_tmp, "generated-bad");
        var (exit, stdout, stderr) = RunCli(
            _tmp, "gen", MetaDir, "--out", outDir, "--column-naming", "PascalCase");
        Assert.Equal(2, exit);
        Assert.Contains("snake_case", stdout + stderr);
    }

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
            throw new FileNotFoundException($"expected the MetaObjects.Cli build output at {dll}", dll);
        return dll;
    }
}
