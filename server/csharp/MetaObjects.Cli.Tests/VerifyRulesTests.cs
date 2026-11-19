using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// <c>dotnet meta verify</c> — the business-rules gate, end to end (ADR-0066). Drives the BUILT CLI, so
/// this proves the wiring: what is printed, where, and what reaches the exit code. The codes, severities
/// and message text are gated cross-port by <c>RulesCheckConformanceTests</c>.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class VerifyRulesTests : IDisposable
{
    private readonly string _tmp = Directory.CreateTempSubdirectory("mo-verify-rules-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { /* best effort */ }
    }

    private const string Plain = """
        metadata:
          package: acme::shop
          children:
            - object.entity:
                name: Order
                children:
                  - field.long: { name: id }
                  - identity.primary: { name: pk, fields: [id] }
        """;

    private const string WithOperations = """
        metadata:
          package: acme::reports
          children:
            - object.entity:
                name: Order
                children:
                  - source.rdb: { table: orders }
                  - field.long: { name: id }
                  - identity.primary: { name: pk, fields: [id] }
                  - field.long: { name: totalCents }
            - object.value:
                name: Totals
                children:
                  - field.long: { name: totalCents }
            - api.operational:
                name: Dashboard
                children:
                  - operation.query: { name: totals, outputRef: Totals }
                  - operation.query: { name: recentOrders, outputRef: Order, many: true, permission: reports.read }
        """;

    private string[] Project(string yaml, string? configRules = null)
    {
        var model = Path.Combine(_tmp, "model");
        Directory.CreateDirectory(model);
        File.WriteAllText(Path.Combine(model, "meta.shop.yaml"), yaml);
        if (configRules is not null)
        {
            Directory.CreateDirectory(Path.Combine(_tmp, ".metaobjects"));
            File.WriteAllText(Path.Combine(_tmp, ".metaobjects", "config.json"),
                $$"""{ "schema_version": 1, {{configRules}} }""");
        }
        var templates = Path.Combine(_tmp, "templates");
        Directory.CreateDirectory(templates);
        return ["verify", model, "--templates", "--prompts", templates];
    }

    [Fact]
    public void A_model_with_no_operation_and_no_transition_prints_nothing()
    {
        var (exitCode, stdout, stderr) = CliProcess.Run(_tmp, Project(Plain));

        Assert.Equal(0, exitCode);
        Assert.Equal("dotnet meta verify --templates: OK" + Environment.NewLine, stdout);
        Assert.Equal("", stderr);
    }

    [Fact]
    public void Operations_print_the_summary_line()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp, Project(WithOperations));

        Assert.Equal(0, exitCode); // the default policy derives a name and reports no error
        var lines = stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Contains("dotnet meta verify — rules: 2 operation(s), 0 lifecycle(s) with 0 transition(s).", lines);
    }

    [Fact]
    public void An_error_severity_diagnostic_fails_the_run()
    {
        var (exitCode, _, stderr) = CliProcess.Run(_tmp,
            Project(WithOperations, "\"rules\": { \"permissions\": { \"names\": \"require\" } }"));

        Assert.Equal(1, exitCode);
        Assert.Contains("WARN_PERMISSION_DERIVED_NAME", stderr);
        Assert.Contains("rules: 1 error(s).", stderr);
    }
}
