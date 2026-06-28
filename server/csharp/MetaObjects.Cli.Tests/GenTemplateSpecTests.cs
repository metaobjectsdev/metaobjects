using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>`dotnet meta gen --template-spec`: declarative Mustache generators
/// appended to the suite, plus clean error handling for a bad template ref.</summary>
public sealed class GenTemplateSpecTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-tspec-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");
    private string TemplateRoot => Path.Combine(_tmp, "templates");
    private string SpecPath => Path.Combine(_tmp, "spec.json");

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public GenTemplateSpecTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(TemplateRoot);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void TemplateSpec_emits_template_output_alongside_default_suite()
    {
        File.WriteAllText(Path.Combine(TemplateRoot, "summary.mustache"), "name={{name}} pkg={{package}}\n");
        File.WriteAllText(SpecPath, """
        { "generators": [
          { "name": "summary", "template": "summary", "scope": "perEntity", "outputPattern": "{name}.summary.txt" }
        ] }
        """);

        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: null, templateRoot: TemplateRoot, templateSpecPath: SpecPath);

        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));
        var summary = Path.Combine(OutDir, "Widget.summary.txt");
        Assert.True(File.Exists(summary), "template-spec output Widget.summary.txt should exist");
        Assert.Equal("name=Widget pkg=acme\n", File.ReadAllText(summary));
        // The default EF suite still runs.
        Assert.True(File.Exists(Path.Combine(OutDir, "Widget.g.cs")));
    }

    [Fact]
    public void TemplateSpec_bad_ref_yields_clean_error_not_exception()
    {
        File.WriteAllText(SpecPath, """
        { "generators": [
          { "name": "missing", "template": "does-not-exist", "scope": "perModel", "outputPattern": "out.txt" }
        ] }
        """);

        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: null, templateRoot: TemplateRoot, templateSpecPath: SpecPath);

        Assert.False(outcome.Ok);
        Assert.Contains(outcome.LoadErrors, e => e.Contains("template render failed") || e.Contains("unresolved"));
    }

    [Fact]
    public void TemplateSpec_with_target_is_rejected()
    {
        File.WriteAllText(SpecPath, """
        { "generators": [
          { "name": "x", "template": "summary", "scope": "perModel", "outputPattern": "out.txt", "target": "web" }
        ] }
        """);

        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated",
            emitAbstractShapes: false, generatorNames: null, templateRoot: TemplateRoot, templateSpecPath: SpecPath);

        Assert.False(outcome.Ok);
        Assert.Contains(outcome.LoadErrors, e => e.Contains("target"));
    }
}
