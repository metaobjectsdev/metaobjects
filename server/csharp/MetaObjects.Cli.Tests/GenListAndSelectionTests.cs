using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// ADR-0021 D3 (C# contained fix) — `dotnet meta gen --list` discoverability +
/// selection of the previously-unreachable generators by stable name, while the
/// default suite (entity/db-context/routes/output-parser) stays unchanged.
/// </summary>
public sealed class GenListAndSelectionTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-list-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");

    // A template.output + its payload VO — the input the extractor/output-parser
    // generators key off (template generators emit per template.output node).
    private const string TemplateMetadata = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "AlphaPayload", "children": [ { "field.string": { "name": "name" } } ] } },
      { "template.output": { "name": "Alpha", "@payloadRef": "AlphaPayload", "@textRef": "a/x", "@format": "json" } }
    ]}}
    """;

    public GenListAndSelectionTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), TemplateMetadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void ListLines_prints_all_generators_with_stable_names_and_descriptions()
    {
        var lines = GenCommand.ListLines();
        Assert.Equal(11, lines.Count);
        foreach (var name in new[]
        {
            "entity", "db-context", "routes", "payload", "output-parser", "extractor",
            "output-prompt", "render-helper", "filter-allowlist", "template",
            // FR-015 — per-entity callable wrapper (storedProc / tableFunction).
            "callable",
        })
        {
            Assert.Contains(lines, l => l.Contains($" {name} —"));
        }
    }

    [Fact]
    public void Default_suite_is_the_python_parity_eight_generators()
    {
        // Parity with the Python default (entity / router / filter-allowlist / payload /
        // output-parser / output-prompt / extractor). render-helper is opt-in (needs
        // --template-root); template / callable stay opt-in.
        Assert.Equal(
            ["entity", "db-context", "routes", "filter-allowlist", "payload", "output-parser", "output-prompt", "extractor"],
            GenCommand.DefaultGeneratorNames);
    }

    [Fact]
    public void Previously_omitted_output_prompt_is_now_selectable_and_emits()
    {
        // output-prompt is one of the five generators the CLI previously could not
        // reach; it emits a prompt fragment per template.output.
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: ["output-prompt"], templateRoot: null);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.Contains(outcome.Result!.Files, f => f.Status == "written");
        Assert.True(File.Exists(Path.Combine(OutDir, "Alpha.prompt.cs")));
    }

    [Fact]
    public void Unknown_generator_name_surfaces_as_an_error_not_a_throw()
    {
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: ["no-such-gen"], templateRoot: null);

        Assert.False(outcome.Ok);
        Assert.Contains(outcome.LoadErrors, e => e.Contains("no-such-gen"));
    }

    [Fact]
    public void Null_generator_names_runs_the_default_suite()
    {
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: null, templateRoot: null);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        // The default suite still includes output-parser, which emits for template.output.
        Assert.True(File.Exists(Path.Combine(OutDir, "Alpha.output.cs")));
    }
}
