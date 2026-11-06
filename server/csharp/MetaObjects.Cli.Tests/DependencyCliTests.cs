// FR-023: `dotnet meta verify` and `fmt` consume a project's metadata dependencies. The corpus
// (fixtures/dependency-conformance/) pins the resolution; these pin that the CLI surface reads it.
using System.Text.Json;
using Xunit;

namespace MetaObjects.Cli.Tests;

// OwnedRunner.Run changes the process-wide working directory and console for the length of a run.
// Outside the serial collection this class ran in parallel with every other class, so
// GenCommandTests.Gen_writes_the_hash_manifest_beside_the_metadata_not_in_cwd read THIS test's
// temp root as "the current directory", found the manifest gen had just written there, and failed
// about one run in five.
[Collection(OwnedRunnerCollection.Name)]
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

    // -- verify --deps (FR-023 Phase 2): the upstream check. The statuses themselves are the corpus's
    // `expectCheck` arm; these pin the CLI around it. --

    /// <summary>One check case of the corpus, laid out under the temp root; returns its project directory.</summary>
    private string CheckProject(string caseName, bool withSnapshot)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CorpusDir(), "cases.json")));
        var c = doc.RootElement.GetProperty("cases").EnumerateArray()
            .Single(x => x.GetProperty("name").GetString() == caseName);
        foreach (var f in c.GetProperty("tree").EnumerateObject()) Write(f.Name, f.Value.GetString()!);
        if (c.TryGetProperty("treeFiles", out var treeFiles))
            foreach (var f in treeFiles.EnumerateObject())
            {
                var dest = Path.Combine(_root, f.Name);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(Path.Combine(CorpusDir(), f.Value.GetString()!), dest);
            }
        var project = Path.Combine(_root, c.GetProperty("resolveFrom").GetString()!);
        Directory.CreateDirectory(Path.Combine(project, ".metaobjects"));
        File.WriteAllText(Path.Combine(project, ".metaobjects", "config.json"), c.GetProperty("config").GetRawText());
        if (c.TryGetProperty("lock", out var lockJson))
            File.WriteAllText(Path.Combine(project, ".metaobjects", "deps.lock.json"), lockJson.GetRawText());
        if (withSnapshot)
        {
            var snapshot = Path.Combine(project, ".metaobjects", "deps", "acme-common", "acme-common.metaobjects.json");
            Directory.CreateDirectory(Path.GetDirectoryName(snapshot)!);
            File.Copy(Path.Combine(CorpusDir(), "artifacts", "acme-common-v1.json"), snapshot);
        }
        return project;
    }

    [Fact]
    public void Verify_deps_passes_when_the_dependency_is_current()
    {
        var project = CheckProject("check-a-matching-artifact-is-current", withSnapshot: true);
        var (exit, stdout, stderr) = CliProcess.Run(project, "verify", "--deps", "--no-field-lint");
        Assert.True(exit == 0, stdout + stderr);
        Assert.Contains("acme-common: current — 1.0.0 (10fbf886)", stdout);
        Assert.Contains("every dependency's installed artifact matches the lock", stdout);
    }

    [Fact]
    public void Verify_deps_fails_on_drift_and_names_the_code()
    {
        var project = CheckProject("check-a-newer-artifact-than-the-lock-has-drifted", withSnapshot: true);
        var (exit, stdout, stderr) = CliProcess.Run(project, "verify", "--deps", "--no-field-lint");
        Assert.NotEqual(0, exit);
        Assert.Contains("acme-common: drifted — lock 1.0.0 (10fbf886), installed 1.1.0 (fa00b9f3)", stderr);
        Assert.Contains("run meta deps sync", stderr);
        Assert.Contains("ERR_DEPENDENCY_UPSTREAM_DRIFT", stderr);
    }

    [Fact]
    public void Verify_deps_reports_a_dependency_not_yet_synced_as_unresolved_then_the_load_refuses_it()
    {
        // No lock file at all: the check says so in its own words first; the metadata load that
        // follows then refuses the missing snapshot and the run exits 2.
        var project = CheckProject("check-a-dependency-with-no-lock-file-is-unresolved", withSnapshot: false);
        var (exit, stdout, stderr) = CliProcess.Run(project, "verify", "--deps", "--no-field-lint");
        Assert.Equal(2, exit);
        Assert.Contains("acme-common: unresolved", stderr);
        Assert.Contains("ERR_DEPENDENCY_UPSTREAM_DRIFT", stderr);
        Assert.Contains("ERR_DEPENDENCY_SNAPSHOT_STALE", stderr);
    }

    [Fact]
    public void A_bare_verify_does_not_run_the_dependency_check()
    {
        var project = CheckProject("check-a-newer-artifact-than-the-lock-has-drifted", withSnapshot: true);
        Directory.CreateDirectory(Path.Combine(project, "templates"));
        var (_, stdout, stderr) = CliProcess.Run(project, "verify", "--no-field-lint");
        Assert.DoesNotContain("drifted", stdout + stderr);
        Assert.DoesNotContain("ERR_DEPENDENCY_UPSTREAM_DRIFT", stdout + stderr);
    }

    [Fact]
    public void Verify_deps_with_nothing_declared_passes()
    {
        Write(".metaobjects/config.json", "{\"schema_version\":1}");
        Write("metaobjects/meta.app.json", """{"metadata.root":{"package":"app","children":[]}}""");
        var (exit, stdout, stderr) = CliProcess.Run(_root, "verify", "--deps", "--no-field-lint");
        Assert.True(exit == 0, stdout + stderr);
        Assert.Contains("no dependencies declared", stdout);
    }
}
