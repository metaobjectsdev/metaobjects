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

    // A responding template.prompt + its VO — the input the extractor/output-parser
    // generators key off (ADR-0052: the inbound tier emits per template.prompt carrying
    // @responseRef; a template.output is outbound only and emits nothing here).
    private const string TemplateMetadata = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "AlphaPayload", "children": [ { "field.string": { "name": "name" } } ] } },
      { "template.prompt": { "name": "Alpha", "@payloadRef": "AlphaPayload", "@responseRef": "AlphaPayload",
                             "@textRef": "a/x", "@format": "text", "@responseFormat": "json" } }
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
        Assert.Equal(12, lines.Count);
        foreach (var name in new[]
        {
            "entity", "db-context", "routes", "payload", "output-parser", "extractor",
            "output-prompt", "render-helper", "filter-allowlist", "template",
            // FR-015 — per-entity callable wrapper (storedProc / tableFunction).
            "callable",
            // Program A / §A5 — per-object physical database name constants.
            "names",
        })
        {
            Assert.Contains(lines, l => l.Contains($" {name} —"));
        }
    }

    [Fact]
    public void There_is_no_default_suite()
    {
        // This port used to run NINE generators for a caller who named none, and this
        // test pinned that list. Codegen is opt-in now: what is pinned instead is that
        // the concept is gone, and that the refusal says how to proceed. Java never had
        // a default set and has been right all along.
        Assert.Contains("--generators", GenCommand.NoGeneratorsSelected);
        Assert.Contains("--list", GenCommand.NoGeneratorsSelected);
    }

    [Fact]
    public void Previously_omitted_output_prompt_is_now_selectable_and_emits()
    {
        // output-prompt is one of the five generators the CLI previously could not
        // reach; it emits a response-format fragment per responding template.prompt.
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: ["output-prompt"], templateRoot: null);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.Contains(outcome.Result!.Files, f => f.Status == "written");
        Assert.True(File.Exists(Path.Combine(OutDir, "Alpha.responseFormat.cs")));
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
    public void Null_generator_names_is_a_usage_error_and_writes_nothing()
    {
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: null, templateRoot: null);

        Assert.False(outcome.Ok);
        Assert.Contains(outcome.LoadErrors, e => e.Contains("--generators"));
        // Nothing was emitted — a refusal that still wrote half a suite would be worse
        // than the default it replaces.
        Assert.False(Directory.Exists(OutDir) && Directory.GetFiles(OutDir).Length > 0);
    }

    [Fact]
    public void An_explicit_selection_still_emits_exactly_what_it_names()
    {
        var outcome = GenCommand.Run(
            MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false,
            generatorNames: ["entity", "payload", "output-parser"], templateRoot: null);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        Assert.True(File.Exists(Path.Combine(OutDir, "Alpha.response.cs")));
    }
}
