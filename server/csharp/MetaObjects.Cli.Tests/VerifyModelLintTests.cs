using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta verify</c> — the three model authoring lints, end to end: each printed as its own
/// advisory section on stderr in the Node order (overlays, names, deprecations, then fields), none
/// reaching the exit code, each muted by its own flag and by its own environment variable. Drives
/// the BUILT CLI (<see cref="CliProcess"/>) so this proves the wiring; the finding text is gated
/// cross-port by <see cref="ModelLintConformanceTests"/>.
/// </summary>
public sealed class VerifyModelLintTests : IDisposable
{
    private const string OverlayHeader = "dotnet meta verify — overlays: 1 unflagged cross-file redeclaration(s) (advisory — does not fail the build):";
    private const string NamesHeader = "dotnet meta verify — names: 1 authoring warning(s) (advisory — does not fail the build):";
    private const string DeprecationsHeader = "dotnet meta verify — deprecations: 1 reference(s) to a deprecated node (advisory — does not fail the build):";

    private readonly string _tmp = Directory.CreateTempSubdirectory("mo-model-lint-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { /* best effort */ }
    }

    /// <summary>
    /// One finding per lint: <c>Owner</c> redeclared in a second file without <c>overlay: true</c>,
    /// a field named <c>"label "</c>, and <c>Item</c> extending the deprecated <c>Legacy</c>.
    /// </summary>
    private (string Model, string Templates) Project(bool clean = false)
    {
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        var label = clean ? "label" : "label ";
        var deprecated = clean ? "" : "\"@deprecated\": \"use Item\",";
        File.WriteAllText(Path.Combine(model, "meta.app.json"), $$"""
            { "metadata.root": { "package": "app", "children": [
              { "object.entity": { "name": "Owner", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } },
              { "object.entity": { "name": "Legacy", "abstract": true, {{deprecated}} "children": [
                { "field.string": { "name": "{{label}}" } } ] } },
              { "object.entity": { "name": "Item", "extends": "Legacy", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }
            ] } }
            """);
        var overlay = clean ? "\"overlay\": true," : "";
        File.WriteAllText(Path.Combine(model, "meta.app.ui.json"), $$"""
            { "metadata.root": { "package": "app", "children": [
              { "object.entity": { "name": "Owner", {{overlay}} "children": [
                { "field.string": { "name": "nickname" } } ] } }
            ] } }
            """);
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);
        return (model, templates);
    }

    private (int ExitCode, string Stderr) Verify(IReadOnlyDictionary<string, string>? env = null, params string[] extra)
    {
        var (model, templates) = Project();
        var (exitCode, stdout, stderr) = CliProcess.RunWithEnvironment(
            _tmp, env ?? new Dictionary<string, string>(), ["verify", model, "--templates", "--prompts", templates, .. extra]);
        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        return (exitCode, stderr);
    }

    [Fact]
    public void Findings_print_in_order_and_do_not_change_the_exit_code()
    {
        var (_, stderr) = Verify();

        var overlays = stderr.IndexOf(OverlayHeader, StringComparison.Ordinal);
        var names = stderr.IndexOf(NamesHeader, StringComparison.Ordinal);
        var deprecations = stderr.IndexOf(DeprecationsHeader, StringComparison.Ordinal);
        Assert.True(overlays >= 0 && names > overlays && deprecations > names, stderr);
        // The file is named relative to the explicit metadata directory.
        Assert.Contains("  WARN_OVERLAY_IMPLICIT: app::Owner is redeclared in meta.app.ui.json without overlay: true", stderr);
        Assert.Contains("  WARN_NAME_SURROUNDING_WHITESPACE [app::Legacy.\"label \"]: ", stderr);
        Assert.Contains("  WARN_DEPRECATED_REFERENCE [app::Item]: extends deprecated object.entity app::Legacy: use Item", stderr);
    }

    [Fact]
    public void Clean_metadata_prints_no_section()
    {
        var (model, templates) = Project(clean: true);
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("overlays:", stderr);
        Assert.DoesNotContain("names:", stderr);
        Assert.DoesNotContain("deprecations:", stderr);
    }

    [Fact]
    public void Name_and_deprecation_lints_read_the_same_load_the_gate_reports()
    {
        var (model, templates) = Project();
        var file = Path.Combine(model, "meta.app.json");
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"name\": \"Item\",", "\"name\": \"Item\", \"@bogusAttr\": \"x\","));

        // Strict (default): the model does not load, so the load-reading lints stay silent; the
        // overlay lint reads raw files and still reports.
        var (strictExit, _, strict) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);
        Assert.NotEqual(0, strictExit);
        Assert.DoesNotContain("names:", strict);
        Assert.DoesNotContain("deprecations:", strict);
        Assert.Contains("WARN_OVERLAY_IMPLICIT", strict);

        // --lax: the same model loads, so both sections print.
        var (laxExit, laxOut, lax) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates, "--lax");
        Assert.True(laxExit == 0, $"stdout={laxOut}\nstderr={lax}");
        Assert.Contains(NamesHeader, lax);
        Assert.Contains(DeprecationsHeader, lax);
    }

    public static TheoryData<string, string, string> OptOuts() => new()
    {
        { "--no-overlay-lint", OverlayLint.EnvOptOut, "WARN_OVERLAY_IMPLICIT" },
        { "--no-name-lint", NameLint.EnvOptOut, "WARN_NAME_SURROUNDING_WHITESPACE" },
        { "--no-deprecation-lint", DeprecationLint.EnvOptOut, "WARN_DEPRECATED_REFERENCE" },
    };

    [Theory]
    [MemberData(nameof(OptOuts))]
    public void Each_flag_mutes_only_its_own_lint(string flag, string _, string code)
    {
        var (_, stderr) = Verify(null, flag);

        Assert.DoesNotContain(code, stderr);
        foreach (var other in new[] { "WARN_OVERLAY_IMPLICIT", "WARN_NAME_SURROUNDING_WHITESPACE", "WARN_DEPRECATED_REFERENCE" }.Where(c => c != code))
            Assert.Contains(other, stderr);
    }

    [Theory]
    [MemberData(nameof(OptOuts))]
    public void Each_environment_variable_mutes_only_its_own_lint(string _, string env, string code)
    {
        var (_, stderr) = Verify(new Dictionary<string, string> { [env] = "1" });

        Assert.DoesNotContain(code, stderr);
        foreach (var other in new[] { "WARN_OVERLAY_IMPLICIT", "WARN_NAME_SURROUNDING_WHITESPACE", "WARN_DEPRECATED_REFERENCE" }.Where(c => c != code))
            Assert.Contains(other, stderr);
    }
}
