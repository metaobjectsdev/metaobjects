// ADR-0062: with no GenConfig.ContextAssemblyName, the DbContext generator names its design-time
// services reference after the .csproj in --out or above it. That file is an input of the run, so
// the key moves when it does, even though it lies outside codegen/ and .metaobjects/.

#nullable enable

using MetaObjects.Codegen;
using Xunit;

public sealed class GenFingerprintProjectFileTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-projfile-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private string Key() => GenFingerprint.Key(GenFingerprint.IdentityEntries(
        _root, _root, new GenFingerprint.Options { OutDir = Path.Combine("app", "Generated") }, []));

    private static string Csproj(string assembly) =>
        $"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><AssemblyName>{assembly}</AssemblyName></PropertyGroup></Project>\n";

    [Fact]
    public void Renaming_the_assembly_of_the_output_project_changes_the_key()
    {
        Directory.CreateDirectory(Path.Combine(_root, "app", "Generated"));
        File.WriteAllText(Path.Combine(_root, "app", "App.csproj"), Csproj("First"));
        var first = Key();
        Assert.Equal(first, Key());

        File.WriteAllText(Path.Combine(_root, "app", "App.csproj"), Csproj("Second"));

        Assert.NotEqual(first, Key());
    }

    [Fact]
    public void A_project_created_after_a_run_without_one_changes_the_key()
    {
        Directory.CreateDirectory(Path.Combine(_root, "app", "Generated"));
        var without = Key();

        File.WriteAllText(Path.Combine(_root, "app", "App.csproj"), Csproj("App"));

        Assert.NotEqual(without, Key());
    }
}
