// AgentContextStalenessTests — the staleness-nudge feature (port of the TS
// agent-context-staleness wiring).
//
// Two things are exercised:
//   1. The pure decision — AgentContextScaffold.AgentContextStaleness(manifest, current):
//        null manifest                 -> null (no agent context here)
//        manifest.GeneratedBy == cur   -> null (in sync; exact equality on purpose)
//        differs / null GeneratedBy    -> a one-line nudge naming both versions + npx meta agent-docs
//   2. The version source — the installed-assembly version is read, never hardcoded.
//
// The stamp test (agent-docs writes generatedBy into the manifest) is removed: agent-docs
// is now a redirect to the Node meta CLI and no longer writes the manifest.

using MetaObjects.AgentContext;
using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class AgentContextStalenessTests
{
    // ---- 1. the pure decision ----------------------------------------------

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
        Assert.Contains("npx meta agent-docs --server csharp", msg);
    }

    [Fact]
    public void Null_generatedBy_nudges_with_older_phrasing()
    {
        var m = ManifestWith(null);
        var msg = AgentContextScaffold.AgentContextStaleness(m, "2.0.0");
        Assert.NotNull(msg);
        Assert.Contains("an older MetaObjects", msg);
        Assert.Contains("2.0.0", msg);
        Assert.Contains("npx meta agent-docs --server csharp", msg);
    }

    // Even a prerelease/build-metadata difference nudges (exact equality, not semver).
    [Fact]
    public void Any_drift_nudges_no_semver_parsing()
    {
        var m = ManifestWith("1.2.3");
        Assert.NotNull(AgentContextScaffold.AgentContextStaleness(m, "1.2.3-rc.1"));
    }

    // ---- 2. version source --------------------------------------------------

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
