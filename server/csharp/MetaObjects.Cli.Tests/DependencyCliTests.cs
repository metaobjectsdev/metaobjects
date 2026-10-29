// FR-023: `dotnet meta verify` and `fmt` consume a project's metadata dependencies. The corpus
// (fixtures/dependency-conformance/) pins the resolution; these pin that the CLI surface reads it.
using System.Text.Json;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class DependencyCliTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-dep-cli-" + Guid.NewGuid().ToString("N"));

    public DependencyCliTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static string CorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures", "dependency-conformance")))
            dir = dir.Parent;
        return Path.Combine(dir!.FullName, "fixtures", "dependency-conformance");
    }

    private void Write(string rel, string content)
    {
        var path = Path.Combine(_root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    /// <summary>The corpus's one-dependency project, with a local entity that EXTENDS an imported one.</summary>
    private void Project()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CorpusDir(), "cases.json")));
        var c = doc.RootElement.GetProperty("cases").EnumerateArray()
            .Single(x => x.GetProperty("name").GetString() == "a-dependency-adds-its-artifact-to-the-resolved-set");
        foreach (var f in c.GetProperty("tree").EnumerateObject()) Write(f.Name, f.Value.GetString()!);
        var snapshot = Path.Combine(_root, ".metaobjects", "deps", "acme-common", "acme-common.metaobjects.json");
        Directory.CreateDirectory(Path.GetDirectoryName(snapshot)!);
        File.Copy(Path.Combine(CorpusDir(), "artifacts", "acme-common-v1.json"), snapshot);
        Write(".metaobjects/config.json", c.GetProperty("config").GetRawText());
        Write(".metaobjects/deps.lock.json", c.GetProperty("lock").GetRawText());
        // A bare `verify` also runs the template gate; an empty directory is enough for it.
        Directory.CreateDirectory(Path.Combine(_root, "templates"));
        Write("metaobjects/meta.vip.json",
            """{"metadata.root":{"package":"app","children":[{"object.entity":{"name":"Vip","extends":"acme::common::Customer","children":[{"source.rdb":{"@table":"vips"}}]}}]}}""");
    }

    [Fact]
    public void Verify_resolves_an_extends_onto_an_imported_node()
    {
        Project();
        var (exit, stdout, stderr) = CliProcess.Run(_root, "verify", "--no-field-lint");
        Assert.True(exit == 0, stdout + stderr);
    }

    [Fact]
    public void Verify_codegen_regenerates_what_gen_wrote_with_a_dependency()
    {
        Project();
        var gen = OwnedRunner.Run(_root, ["entity"], "gen", "--out", "generated", "--namespace", "Acme.Generated");
        Assert.True(gen.ExitCode == 0, gen.Stdout + gen.Stderr);
        Assert.False(Directory.EnumerateFiles(Path.Combine(_root, "generated"), "*Customer*", SearchOption.AllDirectories).Any(),
            "an imported entity must not be generated");

        var verify = OwnedRunner.Run(_root, ["entity"], "verify", "--codegen", "--out", "generated", "--namespace", "Acme.Generated");
        Assert.True(verify.ExitCode == 0, verify.Stdout + verify.Stderr);
    }

    [Fact]
    public void Fmt_resolves_the_dependency_and_never_rewrites_its_snapshot()
    {
        Project();
        var snapshot = Path.Combine(_root, ".metaobjects", "deps", "acme-common", "acme-common.metaobjects.json");
        var before = File.ReadAllBytes(snapshot);

        var (exit, stdout, stderr) = CliProcess.Run(_root, "fmt");
        Assert.True(exit == 0, stdout + stderr);
        Assert.Equal(before, File.ReadAllBytes(snapshot));
    }

    [Fact]
    public void A_stale_snapshot_fails_the_command_and_names_the_fix()
    {
        Project();
        File.AppendAllText(Path.Combine(_root, ".metaobjects", "deps", "acme-common", "acme-common.metaobjects.json"), "\n");

        var (exit, stdout, stderr) = CliProcess.Run(_root, "verify", "--no-field-lint");
        Assert.NotEqual(0, exit);
        Assert.Contains("ERR_DEPENDENCY_SNAPSHOT_STALE", stdout + stderr);
        Assert.Contains("meta deps sync", stdout + stderr);
    }
}
