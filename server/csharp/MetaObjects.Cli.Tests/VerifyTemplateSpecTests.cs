using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// `dotnet meta verify --codegen` must regenerate with the SAME declarative template
/// generators `gen` ran, or it convicts their committed output as stale.
///
/// SP-1 §4 specified "--template-spec &lt;path&gt;, with a conventional default the port
/// auto-discovers and the flag overriding", and that BOTH gen and verify read it. Only
/// the flag on `gen` was ever built: VerifyCommand resolved its own generator list via
/// GeneratorRegistry.Resolve and never looked for a spec. The result was a drift gate
/// failing a project that had just run `gen`, with a remedy that loops — regenerating
/// cannot produce files the regen does not know about, and `verify` takes no
/// --template-spec flag to be told.
///
/// The conventional path is &lt;projectRoot&gt;/template-spec.json, where projectRoot is
/// <see cref="GenCommand.ProjectRootFor"/> — the metadata dir's parent, the same anchor
/// the .gen-state manifest already uses.
/// </summary>
public sealed class VerifyTemplateSpecTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-vtspec-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "generated");
    private string TemplateRoot => Path.Combine(_tmp, "templates");
    private string DiscoveredSpec => Path.Combine(_tmp, "template-spec.json");

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

    public VerifyTemplateSpecTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(TemplateRoot);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
        File.WriteAllText(Path.Combine(TemplateRoot, "summary.mustache"), "name={{name}} pkg={{package}}\n");
        File.WriteAllText(DiscoveredSpec, """
        { "generators": [
          { "name": "summary", "template": "summary", "scope": "perEntity", "outputPattern": "{name}.summary.txt" }
        ] }
        """);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private VerifyCommand.Options CodegenOpts() => new()
    {
        MetadataDir = MetaDir,
        TemplatesRoot = TemplateRoot,
        TemplateRoot = TemplateRoot,
        OutDir = OutDir,
        Templates = false,
        Codegen = true,
        Db = false,
    };

    private void Gen() =>
        Assert.True(
            GenCommand.Run(MetaDir, OutDir, "Acme.Generated", emitAbstractShapes: false,
                generatorNames: null, templateRoot: TemplateRoot).Ok);

    [Fact]
    public void Gen_auto_discovers_the_conventional_spec()
    {
        Gen();
        Assert.True(File.Exists(Path.Combine(OutDir, "Widget.summary.txt")),
            "gen did not discover <projectRoot>/template-spec.json");
    }

    [Fact]
    public void Verify_codegen_is_clean_right_after_gen()
    {
        Gen();
        // Non-vacuous: without discovery there is nothing here for verify to convict.
        Assert.True(File.Exists(Path.Combine(OutDir, "Widget.summary.txt")));

        var r = VerifyCommand.RunSubverbs(CodegenOpts());
        Assert.Equal(0, r.ExitCode);
    }

    [Fact]
    public void Verify_codegen_still_catches_a_deleted_template_file()
    {
        // THE DISCRIMINATING TEST. The lazy fix is to make verify ignore what it does
        // not recognise, which fixes the symptom by blinding the gate.
        Gen();
        File.Delete(Path.Combine(OutDir, "Widget.summary.txt"));

        var r = VerifyCommand.RunSubverbs(CodegenOpts());
        Assert.NotEqual(0, r.ExitCode);
    }

    [Fact]
    public void Verify_codegen_still_catches_an_edited_template_file()
    {
        Gen();
        File.WriteAllText(Path.Combine(OutDir, "Widget.summary.txt"), "tampered\n");

        var r = VerifyCommand.RunSubverbs(CodegenOpts());
        Assert.NotEqual(0, r.ExitCode);
    }

    [Fact]
    public void No_spec_file_leaves_behaviour_unchanged()
    {
        File.Delete(DiscoveredSpec);
        Gen();
        Assert.False(File.Exists(Path.Combine(OutDir, "Widget.summary.txt")));

        var r = VerifyCommand.RunSubverbs(CodegenOpts());
        Assert.Equal(0, r.ExitCode);
    }

    [Fact]
    public void An_explicit_spec_path_overrides_the_discovered_one()
    {
        var other = Path.Combine(_tmp, "other-spec.json");
        File.WriteAllText(other, """
        { "generators": [
          { "name": "flagged", "template": "summary", "scope": "perEntity", "outputPattern": "{name}.flagged.txt" }
        ] }
        """);

        Assert.True(
            GenCommand.Run(MetaDir, OutDir, "Acme.Generated", emitAbstractShapes: false,
                generatorNames: null, templateRoot: TemplateRoot, templateSpecPath: other).Ok);

        Assert.True(File.Exists(Path.Combine(OutDir, "Widget.flagged.txt")), "the flag's spec did not run");
        Assert.False(File.Exists(Path.Combine(OutDir, "Widget.summary.txt")), "the flag must REPLACE discovery");
    }

    [Fact]
    public void A_malformed_discovered_spec_is_a_clean_error()
    {
        File.WriteAllText(DiscoveredSpec, "{ not json");

        var outcome = GenCommand.Run(MetaDir, OutDir, "Acme.Generated", emitAbstractShapes: false,
            generatorNames: null, templateRoot: TemplateRoot);

        // Must fail loudly: silently skipping a broken spec puts gen and verify back
        // out of agreement, which is the defect this whole change exists to remove.
        Assert.False(outcome.Ok);
    }
}
