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
    public void An_undecided_partial_requirement_is_a_recorded_gap_too()
    {
        // `partial` is outstanding work as `planned` is: with no disposition it is counted and said.
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, Project(Requirement("Recorded", "partial", "Order")));

        Assert.True(exitCode == 0, $"exit={exitCode}\nstderr={stderr}");
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Contains(
            "dotnet meta verify — requirements: 1 entries (1 functional, 0 architectural) — 1 partial; " +
            "1/1 entities claimed, counted over 1 metadata file(s).", lines);
        Assert.Contains(
            "dotnet meta verify — requirements: 1 recorded gap(s) with no @disposition. These are known problems " +
            "nobody has ruled on — set 'accepted' or 'deferred' to close the question.", lines);
    }

    [Fact]
    public void The_summary_line_of_a_library_only_project_says_coverage_is_not_measured()
    {
        // The corpus case pins the counts; this pins the sentence they are printed in. The project
        // opts into a library and authors no requirement of its own.
        var corpusCase = Path.Combine(RepoRoot(), "fixtures", "requirement-check-conformance", "coverage-library-only-not-measured");
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        foreach (var file in Directory.GetFiles(Path.Combine(corpusCase, "input")))
            File.Copy(file, Path.Combine(model, Path.GetFileName(file)));
        using var options = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(corpusCase, "options.json")));
        Directory.CreateDirectory(Path.Combine(_tmp, ".metaobjects"));
        File.WriteAllText(Path.Combine(_tmp, ".metaobjects", "config.json"),
            $$"""{ "schema_version": 1, "libraries": {{options.RootElement.GetProperty("libraries").GetRawText()}} }""");
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);

        using var expected = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(corpusCase, "expected.json")));
        var summary = expected.RootElement.GetProperty("summary");
        Assert.False(summary.TryGetProperty("entitiesTotal", out _)); // the case this test is about
        var byStatus = summary.GetProperty("byStatus");
        var statuses = string.Join(", ", new[] { "planned", "live", "partial", "retired" }
            .Where(s => byStatus.TryGetProperty(s, out var n) && n.GetInt32() > 0)
            .Select(s => $"{byStatus.GetProperty(s).GetInt32()} {s}"));

        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);

        Assert.True(exitCode == 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Contains(
            $"dotnet meta verify — requirements: {summary.GetProperty("total").GetInt32()} entries " +
            $"({summary.GetProperty("functional").GetInt32()} functional, {summary.GetProperty("architectural").GetInt32()} architectural) — " +
            $"{statuses}; coverage: not measured (no project-authored requirements).", lines);
        Assert.DoesNotContain("entities claimed", stderr);
    }

    private static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "requirement-check-conformance")) &&
                Directory.Exists(Path.Combine(dir.FullName, "server", "csharp")))
                return dir.FullName;
        }
        throw new InvalidOperationException("could not locate the repo root from " + AppContext.BaseDirectory);
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
    public void The_gate_runs_under_codegen_alone_and_its_errors_reach_the_exit_code()
    {
        // `--codegen` with no generators selected is clean on its own (exit 0), so the exit code here
        // is the requirement gate's. The templates gate does not run at all.
        var args = Project(Requirement("Recorded", "live", "Refund"));
        var model = args[1];
        var codegenArgs = new[] { "verify", model, "--codegen", "--out", Path.Combine(_tmp, "out") };

        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, codegenArgs);

        Assert.True(exitCode == 1, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.DoesNotContain("--templates", stdout);
        Assert.Contains("ERR_REQUIREMENT_DANGLING_REF [Recorded]", stderr);
        Assert.Contains("dotnet meta verify — requirements: 1 error(s).", stderr);

        // The same selection over a model whose only findings are warnings stays at exit 0.
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"), Order + Requirement("Recorded", "live", implementedBy: null));
        var (warnExit, _, warnErr) = CliProcess.Run(_tmp, codegenArgs);
        Assert.Equal(0, warnExit);
        Assert.Contains("  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: ", warnErr);
    }

    [Fact]
    public void The_gate_ignores_no_field_lint()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp,
            Project(Requirement("Recorded", "live", "Refund"), "--no-field-lint"));

        Assert.Equal(1, exitCode);
        Assert.Contains("ERR_REQUIREMENT_DANGLING_REF [Recorded]", stderr);
    }

    // ------------------------------------------------------------------------------------------
    // A model that does not LOAD is not "a model with no requirement". When no gate that ran in
    // this process loaded it, the requirement gate's load is the only one: it reports and fails.
    // ------------------------------------------------------------------------------------------

    /// <summary>A model the loader refuses under any strictness: <c>status</c> is a closed enum.</summary>
    private string UnloadableModel()
    {
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"), Order + Requirement("Recorded", "bogus", "Order"));
        return model;
    }

    /// <summary>
    /// The options Program.cs holds once <c>verify --codegen --out</c> has run in an owned
    /// <c>codegen/</c> project and no other subverb was selected: <c>Codegen</c> cleared and
    /// <c>CodegenHandedOff</c> set. Reaching that state through the CLI needs a real
    /// <c>dotnet run</c> of an owned project (see <c>EjectEndToEndTests</c>), so these tests start
    /// from the state itself.
    /// </summary>
    private VerifyCommand.Options AfterCodegenHandOff(string model) => new()
    {
        MetadataDir = model,
        OutDir = Path.Combine(_tmp, "out"),
        Codegen = false,
        CodegenHandedOff = true,
    };

    [Fact]
    public void After_a_codegen_hand_off_a_model_that_does_not_load_is_reported_by_the_gate_and_fails()
    {
        var opts = AfterCodegenHandOff(UnloadableModel());
        var result = VerifyCommand.RunSubverbs(opts);
        // No gate ran here, so none loaded the model and none reported anything.
        Assert.False(result.RanTemplates);
        Assert.False(result.RanCodegen);
        Assert.Equal(0, result.ExitCode);
        Assert.False(result.LoadFailureReported);

        var output = new StringWriter();
        var exit = VerifyCommand.RunRequirementGate(opts, requireImplementers: false, output, result.LoadFailureReported);

        Assert.Equal(1, exit);
        Assert.Contains("  load error: ERR_BAD_ATTR_VALUE: ", output.ToString());
        Assert.Contains("'bogus'", output.ToString());
        Assert.DoesNotContain("requirements", output.ToString());
    }

    [Fact]
    public void After_a_codegen_hand_off_a_mistyped_attribute_is_refused_with_the_strict_hint_unless_lax()
    {
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        // `planned`, so that once it loads the gate has no finding the ambient strict switch
        // (META_REQUIRE_IMPLEMENTERS, read in-process here) could raise to an error.
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"),
            Order + Requirement("Recorded", "planned", "Order").Replace("implementedBy", "implementdBy"));
        var opts = AfterCodegenHandOff(model);

        var output = new StringWriter();
        var exit = VerifyCommand.RunRequirementGate(opts, requireImplementers: false, output, loadFailureReported: false);
        Assert.Equal(1, exit);
        Assert.Contains("  load error: ERR_UNKNOWN_ATTR: ", output.ToString());
        Assert.Contains("  hint: " + VerifyCommand.UNKNOWN_ATTR_HINT, output.ToString());

        // --lax loads it, and then the gate reads what loaded.
        var lax = new StringWriter();
        Assert.Equal(0, VerifyCommand.RunRequirementGate(opts with { Strict = false }, requireImplementers: false, lax, loadFailureReported: false));
        Assert.DoesNotContain("load error", lax.ToString());
        Assert.Contains("dotnet meta verify — requirements: 1 entries", lax.ToString());
    }

    [Fact]
    public void After_a_codegen_hand_off_a_model_with_no_requirement_still_prints_nothing_and_exits_0()
    {
        // The other side of the boundary: the model LOADS and declares no requirement.
        var opts = AfterCodegenHandOff(Project(requirement: null)[1]);
        var result = VerifyCommand.RunSubverbs(opts);

        var output = new StringWriter();
        Assert.Equal(0, VerifyCommand.RunRequirementGate(opts, requireImplementers: false, output, result.LoadFailureReported));
        Assert.Equal("", output.ToString());
    }

    [Fact]
    public void Codegen_with_no_out_dir_never_loads_so_the_gate_reports_the_model_that_does_not_load()
    {
        // In-process this time, through the built CLI: `--codegen` with no `--out` stops before it
        // loads anything, so here too the gate's load is the only one.
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, "verify", UnloadableModel(), "--codegen");

        Assert.True(exitCode != 0, $"exit={exitCode}\nstdout={stdout}\nstderr={stderr}");
        Assert.Contains("  load error: ERR_BAD_ATTR_VALUE: ", stderr);
        Assert.DoesNotContain("requirements", stdout + stderr);
    }

    [Fact]
    public void A_load_failure_a_gate_already_reported_is_not_reported_again()
    {
        var model = UnloadableModel();
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);

        // The templates gate loaded it and reported it.
        var (templatesExit, _, templatesErr) = CliProcess.Run(_tmp, "verify", model, "--templates", "--prompts", templates);
        Assert.Equal(1, templatesExit);
        Assert.Equal(1, CountOf(templatesErr, "ERR_BAD_ATTR_VALUE"));

        // So did the in-process codegen gate, in its own form.
        var (codegenExit, _, codegenErr) = CliProcess.Run(_tmp, "verify", model, "--codegen", "--out", Path.Combine(_tmp, "out"));
        Assert.NotEqual(0, codegenExit);
        Assert.Contains("verify --codegen: metadata did not load cleanly", codegenErr);
        Assert.Equal(1, CountOf(codegenErr, "ERR_BAD_ATTR_VALUE"));
    }

    private static int CountOf(string text, string needle) => text.Split(needle).Length - 1;

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
