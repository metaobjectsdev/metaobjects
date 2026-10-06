using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta verify</c> — the requirement gate, end to end (ADR-0057). Drives the BUILT CLI
/// (<see cref="CliProcess"/>) so this proves the wiring: what is printed, where, and what reaches the
/// exit code. The codes, conditions and message text are gated cross-port by
/// <c>RequirementCheckConformanceTests</c>, so these tests pin only the CLI's own surface.
/// </summary>
public sealed class VerifyRequirementsTests : IDisposable
{
    private readonly string _tmp = Directory.CreateTempSubdirectory("mo-verify-requirements-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { /* best effort */ }
    }

    private const string Order = """
        metadata:
          package: acme::shop
          children:
            - object.entity:
                name: Order
                children:
                  - field.uuid: { name: id }
                  - identity.primary: { name: pk, fields: [id] }
        """;

    private static string Requirement(string name, string status, string? implementedBy) => $"""

            - requirement.functional:
                name: {name}
                level: 4
                status: {status}
                statement: An order is recorded when it is placed.
                counterexample: A placed order has no row.
        {(implementedBy is null ? "" : $"        implementedBy: [{implementedBy}]")}
        """;

    /// <summary>Writes one metadata file and an empty templates directory; returns the verify arguments.</summary>
    private string[] Project(string? requirement, params string[] extraArgs)
    {
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"), Order + requirement);
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);
        return ["verify", model, "--templates", "--prompts", templates, .. extraArgs];
    }

    [Fact]
    public void A_model_with_no_requirement_prints_nothing_and_changes_no_exit_code()
    {
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, Project(requirement: null));

        // Exactly what the templates gate printed before the requirement gate existed: nothing else,
        // on either stream.
        Assert.Equal(0, exitCode);
        Assert.Equal("dotnet meta verify --templates: OK" + Environment.NewLine, stdout);
        Assert.Equal("", stderr);
    }

    [Fact]
    public void A_model_with_no_requirement_stays_silent_when_a_gate_fails_too()
    {
        // The strict load rejects the made-up attr, so verify exits 1 for its own reason. The
        // requirement gate adds no line to either stream, and no exit code.
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"), Order.Replace("name: Order", "name: Order\n        madeUpAttr: oops"));
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);

        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);

        Assert.Equal(1, exitCode);
        Assert.Contains("FAILED", stdout);
        Assert.DoesNotContain("requirement", stdout + stderr, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_dangling_live_reference_prints_its_lines_and_exits_1()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, Project(Requirement("Recorded", "live", "Refund")));

        Assert.True(exitCode == 1, $"exit={exitCode}\nstderr={stderr}");
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        Assert.Contains(
            "dotnet meta verify — requirements: 1 entries (1 functional, 0 architectural) — 1 live; " +
            "0/1 entities claimed, counted over 1 metadata file(s).", lines);
        Assert.Contains(
            "ERR_REQUIREMENT_DANGLING_REF [Recorded]: 'Refund' does not resolve in the loaded model " +
            "(status 'live' — the model moved and the requirement is stale).", lines);
        Assert.Contains("dotnet meta verify — requirements: 1 error(s).", lines);
        // A diagnostic line carries no command prefix, exactly as the field lint prints its findings.
        Assert.Contains(stderr.Split('\n'), l => l.StartsWith("  ERR_REQUIREMENT_DANGLING_REF [Recorded]: "));
        // The error count closes the gate's output.
        Assert.Equal("dotnet meta verify — requirements: 1 error(s).", lines[^1]);
    }

    [Fact]
    public void Warnings_alone_print_every_line_and_leave_the_exit_code_at_0()
    {
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, Project(Requirement("Recorded", "live", implementedBy: null)));

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.Contains("  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: is 'live' but neither it nor anything nested under it", stderr);
        Assert.Contains("  WARN_REQUIREMENT_OBJECT_UNCLAIMED: no requirement claims 'acme::shop::Order'.", stderr);
        Assert.DoesNotContain("error(s)", stderr);
    }

    [Fact]
    public void A_recorded_gap_with_no_disposition_prints_its_own_line()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, Project(Requirement("Refunded", "planned", implementedBy: null)));

        Assert.Equal(0, exitCode);
        Assert.Contains(
            "dotnet meta verify — requirements: 1 recorded gap(s) with no @disposition. These are known problems " +
            "nobody has ruled on — set 'accepted' or 'deferred' to close the question.", stderr);
    }

    [Fact]
    public void Require_implementers_raises_only_the_existence_finding_to_an_error()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp,
            Project(Requirement("Recorded", "live", implementedBy: null), "--require-implementers"));

        Assert.True(exitCode == 1, $"exit={exitCode}\nstderr={stderr}");
        // The code keeps its WARN_ name; only the severity moves, so the error count includes it.
        Assert.Contains("  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: ", stderr);
        Assert.Contains("dotnet meta verify — requirements: 1 error(s).", stderr);
        Assert.Contains("  WARN_REQUIREMENT_OBJECT_UNCLAIMED: ", stderr);
    }

    [Fact]
    public void The_environment_variable_does_what_the_flag_does()
    {
        var (exitCode, _, stderr) = CliProcess.RunWithEnvironment(_tmp,
            new Dictionary<string, string> { ["META_REQUIRE_IMPLEMENTERS"] = "1" },
            Project(Requirement("Recorded", "live", implementedBy: null)));

        Assert.True(exitCode == 1, $"exit={exitCode}\nstderr={stderr}");
        Assert.Contains("dotnet meta verify — requirements: 1 error(s).", stderr);
    }

    [Fact]
    public void Any_other_value_of_the_environment_variable_is_ignored()
    {
        var (exitCode, _, _) = CliProcess.RunWithEnvironment(_tmp,
            new Dictionary<string, string> { ["META_REQUIRE_IMPLEMENTERS"] = "true" },
            Project(Requirement("Recorded", "live", implementedBy: null)));

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public void The_gate_runs_whichever_gate_was_selected_and_ignores_no_field_lint()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp,
            Project(Requirement("Recorded", "live", "Refund"), "--no-field-lint"));

        Assert.Equal(1, exitCode);
        Assert.Contains("ERR_REQUIREMENT_DANGLING_REF [Recorded]", stderr);
    }

    [Fact]
    public void A_model_that_did_not_load_adds_nothing_and_no_exit_code_of_its_own()
    {
        // Strict load rejects the made-up attr: the command's own load failure is already reported,
        // and the gate neither repeats it nor reads a half-loaded model.
        var args = Project(Requirement("Recorded", "live", "Refund"));
        var file = Path.Combine(_tmp, "model", "meta.shop.yaml");
        File.WriteAllText(file, File.ReadAllText(file).Replace("name: Order\n", "name: Order\n        madeUpAttr: oops\n"));

        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, args);

        Assert.Equal(1, exitCode); // the templates gate's own load failure
        Assert.Contains("ERR_UNKNOWN_ATTR", stderr);
        Assert.DoesNotContain("requirements", stdout + stderr);

        // --lax loads it, so the gate now runs over the same model.
        var (laxExit, _, laxErr) = CliProcess.Run(_tmp, [.. args, "--lax"]);
        Assert.Equal(1, laxExit);
        Assert.Contains("ERR_REQUIREMENT_DANGLING_REF [Recorded]", laxErr);
    }
}
