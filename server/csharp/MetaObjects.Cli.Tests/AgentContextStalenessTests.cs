// AgentContextStalenessTests — the staleness-nudge feature (port of the TS
// agent-context-staleness wiring).
//
// Three things are exercised:
//   1. The stamp — `dotnet meta agent-docs` writes a `generatedBy` into the manifest.
//   2. The pure decision — AgentContextScaffold.AgentContextStaleness(manifest, current):
//        null manifest                 -> null (no agent context here)
//        manifest.GeneratedBy == cur   -> null (in sync; exact equality on purpose)
//        differs / null GeneratedBy    -> a one-line nudge naming both versions + agent-docs
//   3. The version source — the installed-assembly version is read, never hardcoded.

using System.Text.Json;
using MetaObjects.AgentContext;
using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class AgentContextStalenessTests
{
    // ---- 1. the stamp -------------------------------------------------------

    [Fact]
    public void AgentDocs_stamps_generatedBy_into_the_manifest()
    {
        var tmp = Path.Combine(Path.GetTempPath(), "meta-stale-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        try
        {
            // A *.csproj triggers the csharp-server stack auto-detection.
            File.WriteAllText(Path.Combine(tmp, "App.csproj"), "<Project />");

            var exit = AgentDocsCommand.Run(new[] { "--out", tmp });
            Assert.Equal(0, exit);

            var manifestPath = Path.Combine(tmp, AgentContextScaffold.ManifestPath);
            Assert.True(File.Exists(manifestPath), "manifest was not written");

            using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
            Assert.True(doc.RootElement.TryGetProperty("generatedBy", out var gb),
                "manifest is missing the generatedBy property");
            var stamped = gb.GetString();
            Assert.False(string.IsNullOrEmpty(stamped));
            // It must be the live installed version, not a literal.
            Assert.Equal(AgentContextStalenessCheck.CurrentVersion(), stamped);
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { }
        }
    }

    // ---- 2. the pure decision ----------------------------------------------

    [Fact]
    public void Null_manifest_is_not_stale()
    {
        Assert.Null(AgentContextScaffold.AgentContextStaleness(null, "1.2.3"));
    }

    [Fact]
    public void Matching_generatedBy_is_not_stale()
    {
        var m = ManifestWith("1.2.3");
        Assert.Null(AgentContextScaffold.AgentContextStaleness(m, "1.2.3"));
    }

    [Fact]
    public void Differing_generatedBy_nudges_naming_both_versions()
    {
        var m = ManifestWith("1.0.0");
        var msg = AgentContextScaffold.AgentContextStaleness(m, "2.0.0");
        Assert.NotNull(msg);
        Assert.Contains("1.0.0", msg);
        Assert.Contains("2.0.0", msg);
        Assert.Contains("dotnet meta agent-docs", msg);
    }

    [Fact]
    public void Null_generatedBy_nudges_with_older_phrasing()
    {
        var m = ManifestWith(null);
        var msg = AgentContextScaffold.AgentContextStaleness(m, "2.0.0");
        Assert.NotNull(msg);
        Assert.Contains("an older MetaObjects", msg);
        Assert.Contains("2.0.0", msg);
        Assert.Contains("dotnet meta agent-docs", msg);
    }

    // Even a prerelease/build-metadata difference nudges (exact equality, not semver).
    [Fact]
    public void Any_drift_nudges_no_semver_parsing()
    {
        var m = ManifestWith("1.2.3");
        Assert.NotNull(AgentContextScaffold.AgentContextStaleness(m, "1.2.3-rc.1"));
    }

    // ---- 3. version source --------------------------------------------------

    [Fact]
    public void CurrentVersion_reads_a_nonempty_value_from_the_assembly()
    {
        var v = AgentContextStalenessCheck.CurrentVersion();
        Assert.False(string.IsNullOrEmpty(v));
    }

    // ---- helper -------------------------------------------------------------

    private static AgentContextScaffold.Manifest ManifestWith(string? generatedBy) =>
        new(1, generatedBy, Array.Empty<string>(), Array.Empty<string>(),
            new Dictionary<string, string>());
}
