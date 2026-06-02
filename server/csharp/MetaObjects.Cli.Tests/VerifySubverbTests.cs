using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// ADR-0021 D2 fan-out — `dotnet meta verify` explicit subverbs in the C# port.
///   --templates : the historical template/prompt drift gate (unchanged behavior).
///   --codegen   : regenerate-to-temp + diff against the committed --out dir.
///   --db        : NOT supported in C# (schema verify is the migrate engine) → exit 2.
/// A bare `verify` keeps the historical default = templates (back-compat).
/// Combining flags runs each + aggregates the exit code (max; non-zero on any drift).
///
/// These drive the pure-logic dispatch <see cref="VerifyCommand.RunSubverbs"/>, which
/// returns a structured outcome (per-mode results + aggregate exit) with no console I/O.
/// </summary>
public sealed class VerifySubverbTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-verify-sub-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string TplDir => Path.Combine(_tmp, "templates");
    private string OutDir => Path.Combine(_tmp, "generated");

    // template.prompt metadata (for the --templates path).
    private const string TemplateMetadata = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "name" } } ] } },
      { "template.prompt": { "name": "greeting", "@payloadRef": "Payload", "@textRef": "t/main", "@format": "text" } }
    ]}}
    """;

    // object.entity metadata (for the --codegen path).
    private const string EntityMetadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public VerifySubverbTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(TplDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), TemplateMetadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private void WriteTemplate(string body)
    {
        var dir = Path.Combine(TplDir, "t");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "main.mustache"), body);
    }

    private VerifyCommand.Options TemplatesOpts(bool templates = true, bool codegen = false, bool db = false) =>
        new()
        {
            MetadataDir = MetaDir,
            TemplatesRoot = TplDir,
            OutDir = OutDir,
            // Match the namespace the committed output was generated with, so a
            // clean regen is byte-identical (namespace is embedded in the output).
            Namespace = "Acme.Generated",
            Templates = templates,
            Codegen = codegen,
            Db = db,
        };

    // -------------------- --templates (existing behavior under the flag) -----

    [Fact]
    public void Templates_clean_is_exit0()
    {
        WriteTemplate("Hi {{name}}.");
        var r = VerifyCommand.RunSubverbs(TemplatesOpts());
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.RanTemplates);
        Assert.False(r.RanCodegen);
    }

    [Fact]
    public void Templates_drift_is_nonzero()
    {
        WriteTemplate("Hi {{name}}, you have {{notAField}}.");
        var r = VerifyCommand.RunSubverbs(TemplatesOpts());
        Assert.NotEqual(0, r.ExitCode);
    }

    // -------------------- bare verify = templates + note (back-compat) -------

    [Fact]
    public void Bare_verify_defaults_to_templates_and_emits_the_subverb_note()
    {
        WriteTemplate("Hi {{name}}.");
        // No explicit subverb selected.
        var opts = new VerifyCommand.Options
        {
            MetadataDir = MetaDir,
            TemplatesRoot = TplDir,
            OutDir = OutDir,
            Templates = false,
            Codegen = false,
            Db = false,
        };
        var r = VerifyCommand.RunSubverbs(opts);
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.RanTemplates);          // defaulted to templates
        Assert.True(r.EmittedDefaultNote);    // one-line note that subverbs exist
    }

    // -------------------- --db rejected in C# --------------------------------

    [Fact]
    public void Db_subverb_is_rejected_exit2_with_message()
    {
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, db: true));
        Assert.Equal(2, r.ExitCode);
        Assert.NotNull(r.DbRejectionMessage);
        Assert.Contains("migrate", r.DbRejectionMessage!, StringComparison.OrdinalIgnoreCase);
    }

    // -------------------- --codegen -----------------------------------------

    [Fact]
    public void Codegen_clean_committed_output_is_exit0()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");

        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.RanCodegen);
        Assert.NotNull(r.Codegen);
        Assert.True(r.Codegen!.Clean);
    }

    [Fact]
    public void Codegen_mutated_committed_file_is_nonzero_and_named()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");
        File.AppendAllText(Path.Combine(OutDir, "Subscriber.g.cs"), "\n// drift\n");

        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.NotEqual(0, r.ExitCode);
        Assert.Contains(r.Codegen!.DriftedFiles, f => f.EndsWith("Subscriber.g.cs"));
    }

    [Fact]
    public void Codegen_does_not_touch_the_real_out_dir_on_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");
        File.AppendAllText(Path.Combine(OutDir, "Subscriber.g.cs"), "\n// drift\n");

        var before = SnapshotDir(OutDir);
        VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        var after = SnapshotDir(OutDir);
        Assert.Equal(before, after);
    }

    [Fact]
    public void Codegen_without_committed_output_is_exit2()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        // Never ran gen → OutDir absent → nothing to diff against → exit 2.
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.Equal(2, r.ExitCode);
        Assert.NotNull(r.Codegen!.Error);
    }

    // -------------------- combining flags aggregates exit --------------------

    [Fact]
    public void Combining_templates_and_codegen_aggregates_max_exit()
    {
        // Templates clean (exit 0) but codegen has no committed output (exit 2).
        WriteTemplate("Hi {{name}}.");
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: true, codegen: true));
        Assert.True(r.RanTemplates);
        Assert.True(r.RanCodegen);
        Assert.Equal(2, r.ExitCode); // max(0, 2)
    }

    private static Dictionary<string, string> SnapshotDir(string dir)
    {
        var snap = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!Directory.Exists(dir)) return snap;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            snap[Path.GetRelativePath(dir, f)] = File.ReadAllText(f);
        return snap;
    }
}
