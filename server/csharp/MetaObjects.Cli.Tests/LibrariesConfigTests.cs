using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// FR-043 — the C# CLI has no <c>--libraries</c> flag (the Node CLI has none either;
/// <c>.metaobjects/config.json</c>'s <c>libraries</c> key is the interface), so
/// <c>dotnet meta gen</c>/<c>verify</c>/<c>docs</c> must read it from the config the
/// same way the other ports do. Before this, the C# CLI had NO library support at
/// all — an adopter who opted into any library could not generate C# at all: their
/// own metadata `extends`-referenced a shipped library base
/// (<c>metaobjects::ai::LlmCallBase</c>), and with the library not loaded that
/// reference failed to resolve.
///
/// <para>Drives the BUILT CLI assembly as a subprocess (<see cref="CliProcess"/>), like
/// <see cref="MetadataDirFallbackTests"/>, so this proves the WIRING, not just the
/// already-tested loader API (<c>MetaObjects.Conformance.Tests.LibraryLoadTests</c>
/// covers <c>MetaDataLoader.FromDirectory(dir, libraries)</c> directly).</para>
/// </summary>
public sealed class LibrariesConfigTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-libraries-" + Guid.NewGuid().ToString("N"));

    // Mirrors LibraryLoadTests.Model: an entity `extends`-ing the "ai" library's
    // shipped LlmCallBase. Without the opt-in, this reference does not resolve.
    private const string Model = """
    { "metadata.root": { "package": "acme::trace", "children": [
      { "object.entity": { "name": "AgentCall", "extends": "metaobjects::ai::LlmCallBase", "children": [
        { "source.rdb": { "@table": "agent_call" } },
        { "identity.primary": { "name": "pk", "@fields": ["spanId"] } }
      ]}}
    ]}}
    """;

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Gen_with_no_positional_metadataDir_resolves_libraries_from_the_ladder_config()
    {
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Model);
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "sources": [ { "path": "model" } ], "libraries": ["ai"] }""");

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "gen", "--generators", "entity", "--out", outDir, "--namespace", "Acme.Generated");

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.True(File.Exists(Path.Combine(outDir, "AgentCall.g.cs")), stdout + stderr);
        // The inherited field from the library's LlmCallBase must be on the generated
        // class — proof the library's base actually resolved, not merely that the
        // load didn't error.
        Assert.Contains("TraceId", File.ReadAllText(Path.Combine(outDir, "AgentCall.g.cs")));
    }

    [Fact]
    public void Gen_with_an_explicit_positional_metadataDir_STILL_resolves_libraries_from_the_project_root_config()
    {
        // Obstacle 1: Program.cs used to return early for an explicit <metadataDir>,
        // before the port-neutral config was ever consulted — so a caller passing
        // the directory explicitly (the exact shape of the real-world repro) got no
        // library support at all, even though the ladder path (the test above) did.
        // The project root here is the directory HOLDING the explicit "model" dir —
        // the same anchor GenCommand.ProjectRootFor uses for `.gen-state` — so
        // `.metaobjects/config.json` sits beside "model", not inside it.
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Model);
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "libraries": ["ai"] }""");

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "gen", "--generators", "entity", modelDir, "--out", outDir, "--namespace", "Acme.Generated");

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.True(File.Exists(Path.Combine(outDir, "AgentCall.g.cs")), stdout + stderr);
        Assert.Contains("TraceId", File.ReadAllText(Path.Combine(outDir, "AgentCall.g.cs")));
    }

    [Fact]
    public void Gen_with_an_explicit_positional_metadataDir_and_no_libraries_opt_in_still_fails_to_resolve()
    {
        // The negative arm (mirrors LibraryLoadTests' own pairing): proves the opt-in
        // is doing the work, not that the loader has quietly made the library
        // unconditional. Same explicit-<metadataDir> shape as the test above, but no
        // "libraries" key at all.
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Model);

        var outDir = Path.Combine(_tmp, "generated");
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, "gen", "--generators", "entity", modelDir, "--out", outDir, "--namespace", "Acme.Generated");

        Assert.Equal(1, exitCode);
        Assert.Contains("load error:", stderr);
        Assert.False(Directory.Exists(outDir));
    }

    [Fact]
    public void Docs_with_an_explicit_positional_metadataDir_also_resolves_libraries()
    {
        // The task requires EVERY metadata-loading command (gen, verify, docs) to
        // read `libraries` regardless of ladder vs. explicit <metadataDir> — this
        // covers `docs` on the explicit-dir path.
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Model);
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "libraries": ["ai"] }""");

        var outDir = Path.Combine(_tmp, "apidocs");
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "docs", modelDir, "--out", outDir);

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
    }

    [Fact]
    public void Verify_with_an_explicit_positional_metadataDir_also_resolves_libraries()
    {
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), Model);
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "libraries": ["ai"] }""");
        var templatesDir = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templatesDir);

        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "verify", modelDir, "--templates", "--prompts", templatesDir, "--lax");

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.DoesNotContain("ERR_UNRESOLVED_SUPER", stderr);
    }

    [Fact]
    public void An_unknown_library_token_is_a_clear_config_error_not_a_silent_skip()
    {
        // ERR_UNKNOWN_LIBRARY already existed in Errors.cs (reserved for exactly this),
        // unused until this fix wired a reader that could raise it. A human typo in
        // the config is a mistake worth failing on loudly — LibrarySources.Resolve's
        // own silent-skip is only right for a programmatic caller, never for a name a
        // human wrote into a config file.
        var modelDir = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(modelDir);
        File.WriteAllText(Path.Combine(modelDir, "meta.acme.json"), """{ "metadata.root": { "children": [] } }""");
        var cfgDir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        File.WriteAllText(
            Path.Combine(cfgDir, "config.json"),
            """{ "schema_version": 1, "libraries": ["not-a-real-library"] }""");

        var (exitCode, _, stderr) = CliProcess.Run(_tmp, "gen", "--generators", "entity", modelDir, "--out", Path.Combine(_tmp, "generated"), "--namespace", "X");

        Assert.Equal(2, exitCode);
        Assert.Contains("ERR_UNKNOWN_LIBRARY", stderr);
        Assert.Contains("not-a-real-library", stderr);
    }
}
