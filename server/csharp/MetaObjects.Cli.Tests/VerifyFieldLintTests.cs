using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta verify</c> — the field authoring lint, end to end: printed as its own
/// advisory section on stderr, never reaching the exit code, and muted by
/// <c>--no-field-lint</c>. Drives the BUILT CLI (<see cref="CliProcess"/>) so this proves
/// the wiring; the finding text is gated cross-port by <see cref="FieldLintConformanceTests"/>.
/// </summary>
public sealed class VerifyFieldLintTests : IDisposable
{
    private readonly string _tmp = Directory.CreateTempSubdirectory("mo-field-lint-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { /* best effort */ }
    }

    private (string Model, string Templates) Project(string referenceField, bool duplicateLabel)
    {
        const string label = """{ "field.string": { "name": "label" } },""";
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        File.WriteAllText(Path.Combine(model, "meta.app.json"), $$"""
            { "metadata.root": { "package": "app", "children": [
              { "object.entity": { "name": "Owner", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } },
              { "object.entity": { "name": "Item", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "ownerId" } },
                {{label}}
                {{(duplicateLabel ? label : "")}}
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "identity.reference": { "name": "owner_fk", "@fields": ["{{referenceField}}"], "@references": "Owner" } } ] } }
            ] } }
            """);
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);
        return (model, templates);
    }

    [Fact]
    public void Findings_are_advisory_and_do_not_change_the_exit_code()
    {
        var (model, templates) = Project("ownerIdd", duplicateLabel: true);
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.Contains("dotnet meta verify — fields: 2 authoring warning(s) (advisory — does not fail the build):", stderr);
        Assert.Contains("WARN_REFERENCE_FIELD_NOT_FOUND [app::Item.owner_fk]", stderr);
        Assert.Contains("WARN_DUPLICATE_FIELD_NAME [app::Item.label]", stderr);
    }

    [Fact]
    public void Clean_metadata_prints_no_section()
    {
        var (model, templates) = Project("ownerId", duplicateLabel: false);
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("fields:", stderr);
    }

    [Fact]
    public void No_field_lint_silences_it()
    {
        var (model, templates) = Project("ownerIdd", duplicateLabel: true);
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates, "--no-field-lint");

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("WARN_REFERENCE_FIELD_NOT_FOUND", stderr);
        Assert.DoesNotContain("WARN_DUPLICATE_FIELD_NAME", stderr);
    }
}
