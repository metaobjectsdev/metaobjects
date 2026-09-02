using MetaObjects.Cli;
using MetaObjects.Codegen;
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

    // -------------------- the namespace-inference footgun --------------------
    // gen used a CUSTOM namespace; verify --codegen WITHOUT --namespace must infer
    // it from the committed output (else every file would spuriously drift on the
    // embedded `namespace {ns};`). Build the Options with NO explicit namespace.

    /// <summary>Codegen opts with NO explicit namespace (the footgun scenario).</summary>
    private VerifyCommand.Options CodegenOptsNoNamespace() =>
        new()
        {
            MetadataDir = MetaDir,
            OutDir = OutDir,
            Codegen = true,
            // Namespace intentionally NOT set + NamespaceExplicit defaults to false.
        };

    [Fact]
    public void Codegen_infers_custom_namespace_from_committed_output_no_flag()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        // Committed output generated with a CUSTOM namespace.
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");

        // verify --codegen WITHOUT --namespace → must infer "Acme.Generated" from the
        // committed files and produce a byte-identical regen → exit 0 (no spurious drift).
        var r = VerifyCommand.RunSubverbs(CodegenOptsNoNamespace());
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.Codegen!.Clean, string.Join("; ", r.Codegen!.Lines));
    }

    [Fact]
    public void Codegen_inference_still_detects_real_drift_with_custom_namespace()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");
        // A real hand-edit on top of the custom namespace must still be drift.
        File.AppendAllText(Path.Combine(OutDir, "Subscriber.g.cs"), "\n// real drift\n");

        var r = VerifyCommand.RunSubverbs(CodegenOptsNoNamespace());
        Assert.NotEqual(0, r.ExitCode);
        Assert.Contains(r.Codegen!.DriftedFiles, f => f.EndsWith("Subscriber.g.cs"));
    }

    [Fact]
    public void Codegen_explicit_namespace_still_wins_over_inference()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated");

        // Explicit namespace set (matching) → wins, byte-identical regen → exit 0.
        var opts = new VerifyCommand.Options
        {
            MetadataDir = MetaDir,
            OutDir = OutDir,
            Namespace = "Acme.Generated",
            NamespaceExplicit = true,
            Codegen = true,
        };
        var r = VerifyCommand.RunSubverbs(opts);
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.Codegen!.Clean, string.Join("; ", r.Codegen!.Lines));
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

    // -------------------- --column-naming (the codegen regen must be told) ----
    // `gen --column-naming snake_case` emits `<Entity>Names.g.cs` physical-column
    // constants under that strategy (see ColumnNamingFlagTests). A `verify --codegen`
    // blind to the flag regenerates with the Literal default and convicts every one
    // of them as drift on an otherwise-clean project — the "gate convicts a correct
    // project" pattern this project's own CHANGELOG names as a defect class.
    // `createdAt` carries a case boundary so the two strategies produce different
    // committed content (EntityMetadata's `email` field above has none).
    private const string ColumnNamingMetadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "createdAt" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private VerifyCommand.Options ColumnNamingOpts(ColumnNamingStrategy verifyStrategy) => new()
    {
        MetadataDir = MetaDir,
        OutDir = OutDir,
        Namespace = "Acme.Generated",
        NamespaceExplicit = true,
        Codegen = true,
        ColumnNaming = verifyStrategy,
    };

    [Fact]
    public void Codegen_with_matching_column_naming_is_clean()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), ColumnNamingMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated", false, null, null, null, ColumnNamingStrategy.SnakeCase);

        var r = VerifyCommand.RunSubverbs(ColumnNamingOpts(ColumnNamingStrategy.SnakeCase));
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.Codegen!.Clean, string.Join("; ", r.Codegen!.Lines));
    }

    [Fact]
    public void Codegen_with_mismatched_column_naming_reports_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), ColumnNamingMetadata);
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated", false, null, null, null, ColumnNamingStrategy.SnakeCase);

        // The discriminating half: a verify blind to --column-naming (accepting it but
        // dropping it, or never reading Options.ColumnNaming) would ALSO pass the
        // clean-case test above under its own hardcoded default — only a genuinely
        // MISMATCHED strategy proves the flag is actually threaded into the regen.
        var r = VerifyCommand.RunSubverbs(ColumnNamingOpts(ColumnNamingStrategy.Literal));
        Assert.NotEqual(0, r.ExitCode);
        Assert.Contains(r.Codegen!.DriftedFiles, f => f.EndsWith("SubscriberNames.g.cs"));
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
