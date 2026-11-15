// ADR-0062: with no GenConfig.ContextAssemblyName, the DbContext generator names its design-time
// services reference after the .csproj in --out or above it. That file is an input of the run, so
// the key moves when it does, even though it lies outside codegen/ and .metaobjects/.

#nullable enable

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using Xunit;

[Collection("Console")]
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

    // ---- end to end: `dotnet meta gen` on a Postgres project whose .csproj sits above --out

    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");
    private string Services => Path.Combine(Out, "AppDbContextDesignTimeServices.g.cs");
    private string StateFile => Path.Combine(_root, ".metaobjects", ".gen-state", GenFingerprint.FileName);

    private void Project(string assembly)
    {
        Directory.CreateDirectory(Meta);
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), """{ "schema_version": 1, "migrate": { "dialect": "postgres" } }""");
        File.WriteAllText(Path.Combine(Meta, "meta.acme.json"), """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment", "@sequenceStart": 100 } }
          ]}}
        ]}}
        """);
        File.WriteAllText(Path.Combine(_root, "App.csproj"), Csproj(assembly));
    }

    private (int Code, string Text) Gen()
    {
        var (cwd, prevOut, prevErr) = (Directory.GetCurrentDirectory(), Console.Out, Console.Error);
        var (o, e) = (new StringWriter(), new StringWriter());
        Directory.SetCurrentDirectory(_root);
        Console.SetOut(o);
        Console.SetError(e);
        try { return (CodegenCli.Run(["gen", Meta, "--out", Out, "--namespace", "Acme.Generated"], [new DbContextGenerator()]), o + "\n" + e); }
        finally { Console.SetOut(prevOut); Console.SetError(prevErr); Directory.SetCurrentDirectory(cwd); }
    }

    private static string Reference(string assembly) =>
        $"DesignTimeServicesReference(\"Acme.Generated.AppDbContextDesignTimeServices, {assembly}\"";

    [Fact]
    public void Renaming_the_assembly_renders_again_and_the_reference_names_the_new_one()
    {
        Project("First");
        var (first, firstText) = Gen();
        Assert.True(first == 0, firstText);
        Assert.Contains(Reference("First"), File.ReadAllText(Services));
        var (again, againText) = Gen();
        Assert.True(again == 0, againText);
        Assert.Contains("nothing changed since the last run; skipped", againText);

        File.WriteAllText(Path.Combine(_root, "App.csproj"), Csproj("Second"));
        var (renamed, renamedText) = Gen();

        Assert.True(renamed == 0, renamedText);
        Assert.DoesNotContain("skipped", renamedText);
        Assert.Contains(Reference("Second"), File.ReadAllText(Services));
    }

    [Fact]
    public void A_state_file_of_the_previous_format_is_not_a_match_and_gen_renders()
    {
        Project("App");
        var (first, firstText) = Gen();
        Assert.True(first == 0, firstText);
        Assert.True(File.Exists(StateFile), firstText);
        var stored = File.ReadAllText(StateFile);
        Assert.Contains($"\"format\": {GenFingerprint.FormatVersion}", stored);
        File.WriteAllText(StateFile, stored.Replace($"\"format\": {GenFingerprint.FormatVersion}", "\"format\": 3"));

        Assert.Null(GenFingerprint.Read(_root));
        var (second, secondText) = Gen();
        Assert.True(second == 0, secondText);
        Assert.DoesNotContain("skipped", secondText);
        Assert.Contains($"\"format\": {GenFingerprint.FormatVersion}", File.ReadAllText(StateFile));
    }
}
