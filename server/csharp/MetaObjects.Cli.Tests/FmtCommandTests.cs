using MetaObjects.Cli;
using MetaObjects.Config;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// `dotnet meta fmt` (#304) — mirrors the TS reference
/// (server/typescript/packages/metadata/test/fmt.test.ts +
/// server/typescript/packages/cli/test/integration/fmt.test.ts). Exercises
/// FmtCommand's pure logic directly (fast) plus one end-to-end pass through
/// the real built CLI (CliProcess), matching this test project's own
/// convention of pairing both for a new command.
/// </summary>
public sealed class FmtCommandTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-fmt-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");

    public FmtCommandTests() => Directory.CreateDirectory(MetaDir);
    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private static TypeRegistry DefaultRegistry() => new MetaDataLoader().Registry;

    // ------------------------------------------------------------------
    // FmtCommand.FormatFile — standalone single-file formatting
    // ------------------------------------------------------------------

    [Fact]
    public void FormatFile_reformats_a_messy_but_valid_file()
    {
        const string messy = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "@description": "a widget", "name": "Widget", "children": [
            { "field.string": { "name": "name", "@required": true } }
          ]}}
        ]}}
        """;

        var result = FmtCommand.FormatFile(messy, DefaultRegistry(), "meta.widget.json");
        Assert.True(result.Ok);
        Assert.Equal(
            "{\n  \"metadata.root\": {\n    \"package\": \"acme\",\n    \"children\": [\n      {\n        \"object.entity\": {\n          \"name\": \"Widget\",\n          \"@description\": \"a widget\",\n          \"children\": [\n            {\n              \"field.string\": {\n                \"name\": \"name\",\n                \"@required\": true\n              }\n            }\n          ]\n        }\n      }\n    ]\n  }\n}\n",
            result.Text);
    }

    [Fact]
    public void FormatFile_is_idempotent()
    {
        const string messy = """
        { "metadata.root": { "children": [
          { "object.entity": { "name": "B", "children": [] } },
          { "object.entity": { "name": "A", "children": [] } }
        ]}}
        """;
        var registry = DefaultRegistry();
        var once = FmtCommand.FormatFile(messy, registry, "a.json");
        Assert.True(once.Ok);
        var twice = FmtCommand.FormatFile(once.Text!, registry, "a.json");
        Assert.True(twice.Ok);
        Assert.Equal(once.Text, twice.Text);
    }

    [Fact]
    public void FormatFile_preserves_a_cross_file_extends_ref_without_erroring()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Car", "extends": "acme::Vehicle", "children": [] } }
        ]}}
        """;
        var result = FmtCommand.FormatFile(doc, DefaultRegistry(), "meta.car.json");
        Assert.True(result.Ok);
        Assert.Contains("\"extends\": \"acme::Vehicle\"", result.Text);
    }

    [Fact]
    public void FormatFile_normalizes_a_scalar_fields_attr_to_its_array_form()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "User", "children": [
            { "field.string": { "name": "email" } },
            { "identity.secondary": { "name": "byEmail", "@fields": "email" } }
          ]}}
        ]}}
        """;
        var result = FmtCommand.FormatFile(doc, DefaultRegistry(), "meta.user.json");
        Assert.True(result.Ok);
        Assert.Contains("\"@fields\": [\n                  \"email\"\n                ]", result.Text);
    }

    [Fact]
    public void FormatFile_reports_overlay_for_an_overlay_with_no_local_base()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "User", "overlay": true, "children": [
            { "field.string": { "name": "nickname" } }
          ]}}
        ]}}
        """;
        var result = FmtCommand.FormatFile(doc, DefaultRegistry(), "meta.user.ui.json");
        Assert.False(result.Ok);
        Assert.True(result.Overlay);
    }

    [Fact]
    public void FormatFile_reports_a_mixed_file_as_overlay_whole()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Plain", "children": [] } },
          { "object.entity": { "name": "Other", "overlay": true, "children": [] } }
        ]}}
        """;
        var result = FmtCommand.FormatFile(doc, DefaultRegistry(), "mixed.json");
        Assert.False(result.Ok);
        Assert.True(result.Overlay);
    }

    [Fact]
    public void FormatFile_reports_a_non_overlay_error_for_an_unregistered_subtype()
    {
        const string doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.thisSubtypeDoesNotExist": { "name": "Bogus", "children": [] } }
        ]}}
        """;
        var result = FmtCommand.FormatFile(doc, DefaultRegistry(), "bad.json");
        Assert.False(result.Ok);
        Assert.False(result.Overlay);
    }

    [Fact]
    public void FormatFile_reports_an_error_for_invalid_json()
    {
        var result = FmtCommand.FormatFile("{ not json", DefaultRegistry(), "broken.json");
        Assert.False(result.Ok);
        Assert.False(result.Overlay);
        Assert.False(string.IsNullOrEmpty(result.Message));
    }

    // ------------------------------------------------------------------
    // FmtCommand.Run — whole-project orchestration + safety check
    // ------------------------------------------------------------------

    private const string MessyWidget = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "@description": "A widget", "name": "Widget", "children": [
        { "field.string": { "name": "sku", "@maxLength": 40, "@required": true } }
      ]}}
    ]}}
    """;

    private const string CanonicalGadget = "{\n  \"metadata.root\": {\n    \"package\": \"acme\",\n    \"children\": [\n      {\n        \"object.entity\": {\n          \"name\": \"Gadget\",\n          \"children\": [\n            {\n              \"field.string\": {\n                \"name\": \"label\"\n              }\n            }\n          ]\n        }\n      }\n    ]\n  }\n}\n";

    private const string OverlayWidgetUi = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "overlay": true, "children": [
        { "field.string": { "name": "notes" } }
      ]}}
    ]}}
    """;

    private void WriteFixture()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.base.json"), MessyWidget);
        File.WriteAllText(Path.Combine(MetaDir, "meta.already-canonical.json"), CanonicalGadget);
        File.WriteAllText(Path.Combine(MetaDir, "meta.widget.ui.json"), OverlayWidgetUi);
        File.WriteAllText(Path.Combine(MetaDir, "meta.extra.yaml"), "metadata:\n  package: acme\n  children: []\n");
    }

    [Fact]
    public void Run_reformats_messy_leaves_canonical_skips_overlay_and_yaml()
    {
        WriteFixture();
        var resolved = new ResolvedMetadata(MetaDir, null, Array.Empty<string>());

        var result = FmtCommand.Run(resolved, check: false);
        Assert.Null(result.Fatal);

        var byName = result.Files.ToDictionary(f => Path.GetFileName(f.Path));
        Assert.Equal(FmtCommand.FileStatus.Formatted, byName["meta.base.json"].Status);
        Assert.Equal(FmtCommand.FileStatus.Unchanged, byName["meta.already-canonical.json"].Status);
        Assert.Equal(FmtCommand.FileStatus.SkippedOverlay, byName["meta.widget.ui.json"].Status);
        Assert.Equal(FmtCommand.FileStatus.SkippedYaml, byName["meta.extra.yaml"].Status);

        Assert.Equal(CanonicalGadget, File.ReadAllText(Path.Combine(MetaDir, "meta.already-canonical.json")));
        Assert.NotEqual(MessyWidget, File.ReadAllText(Path.Combine(MetaDir, "meta.base.json")));
    }

    [Fact]
    public void Run_check_mode_changes_nothing_on_disk()
    {
        WriteFixture();
        var resolved = new ResolvedMetadata(MetaDir, null, Array.Empty<string>());
        var before = File.ReadAllText(Path.Combine(MetaDir, "meta.base.json"));

        var result = FmtCommand.Run(resolved, check: true);
        Assert.Null(result.Fatal);
        Assert.Contains(result.Files, f => f.Status == FmtCommand.FileStatus.WouldFormat);
        Assert.Equal(before, File.ReadAllText(Path.Combine(MetaDir, "meta.base.json")));
    }

    [Fact]
    public void Run_refuses_when_the_project_does_not_load_cleanly()
    {
        File.WriteAllText(Path.Combine(MetaDir, "bad.json"), "{ this is not valid json");
        var resolved = new ResolvedMetadata(MetaDir, null, Array.Empty<string>());

        var result = FmtCommand.Run(resolved, check: false);
        Assert.NotNull(result.Fatal);
        Assert.Empty(result.Files);
    }

    // ------------------------------------------------------------------
    // End-to-end through the real built CLI (mirrors other *CommandTests)
    // ------------------------------------------------------------------

    [Fact]
    public void Cli_fmt_reformats_and_is_idempotent()
    {
        WriteFixture();
        var first = CliProcess.Run(_tmp, "fmt");
        Assert.Equal(0, first.ExitCode);

        var once = File.ReadAllText(Path.Combine(MetaDir, "meta.base.json"));
        var second = CliProcess.Run(_tmp, "fmt");
        Assert.Equal(0, second.ExitCode);
        Assert.Equal(once, File.ReadAllText(Path.Combine(MetaDir, "meta.base.json")));
    }

    [Fact]
    public void Cli_fmt_check_exits_nonzero_when_drift_exists()
    {
        WriteFixture();
        var result = CliProcess.Run(_tmp, "fmt", "--check");
        Assert.Equal(1, result.ExitCode);
    }
}
