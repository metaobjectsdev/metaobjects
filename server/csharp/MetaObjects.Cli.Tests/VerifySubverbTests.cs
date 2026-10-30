using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Meta;
using MetaObjects.Render;
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
            // verify --codegen re-runs the SELECTION; there is no default suite to fall
            // back on, so the mechanics tests name the one their fixtures were written for.
            Generators = GenSuite.Names,
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

    // ADR-0061: Jinja bodies are a Python/TypeScript engine. Here a Jinja-only body is
    // refused by name instead of being reported as an unresolved ref.
    [Fact]
    public void Templates_jinja_only_body_is_refused_by_code()
    {
        var dir = Path.Combine(TplDir, "t");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "main.jinja"), "Hi {{ name }}.");
        var outcome = VerifyCommand.Run(MetaDir, TplDir);
        Assert.Contains(outcome.Errors, d => d.Code == TemplateEngines.ErrTemplateEngineUnsupported && d.Path == "t/main");
        Assert.Empty(outcome.UnresolvedText);
        Assert.NotEqual(0, VerifyCommand.RunSubverbs(TemplatesOpts()).ExitCode);
    }

    // An ejected project's `verify --codegen` runs in its owned runner, so the in-process
    // gate sees Codegen=false. That must not read as a BARE verify: it used to fall through
    // to the templates default with no root and crash in FilesystemProvider.
    [Fact]
    public void Codegen_handed_off_is_not_a_bare_verify()
    {
        var handedOff = new VerifyCommand.Options
        {
            MetadataDir = MetaDir,
            OutDir = OutDir,
            CodegenHandedOff = true,
        };

        var r = VerifyCommand.RunSubverbs(handedOff);

        Assert.Equal(0, r.ExitCode);
        Assert.False(r.RanTemplates);
        Assert.False(r.EmittedDefaultNote);
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
            // verify --codegen re-runs the SELECTION; there is no default suite to fall
            // back on, so the mechanics tests name the one their fixtures were written for.
            Generators = GenSuite.Names,
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

    // The cross-port default set: a bare verify runs the codegen gate beside templates, so
    // "run `dotnet meta verify` in CI" fails on generated output that fell behind the model.
    [Fact]
    public void Bare_verify_runs_the_codegen_gate_beside_templates_and_fails_on_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), TemplateMetadata + "\n");
        WriteTemplate("Hi {{name}}.");
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");
        var bare = TemplatesOpts(templates: false, codegen: true) with { Bare = true };

        var clean = VerifyCommand.RunSubverbs(bare);
        Assert.Equal(0, clean.ExitCode);
        Assert.True(clean.RanTemplates);
        Assert.True(clean.RanCodegen);
        Assert.True(clean.EmittedDefaultNote);

        foreach (var f in Directory.EnumerateFiles(OutDir, "*.g.cs", SearchOption.AllDirectories).Take(1))
            File.AppendAllText(f, "\n// drift\n");
        var drifted = VerifyCommand.RunSubverbs(bare);
        Assert.NotEqual(0, drifted.ExitCode);
        Assert.True(drifted.RanTemplates);
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
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");

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
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");
        File.AppendAllText(Path.Combine(OutDir, "Subscriber.g.cs"), "\n// drift\n");

        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.NotEqual(0, r.ExitCode);
        Assert.Contains(r.Codegen!.DriftedFiles, f => f.EndsWith("Subscriber.g.cs"));
    }

    [Fact]
    public void Codegen_does_not_touch_the_real_out_dir_on_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");
        File.AppendAllText(Path.Combine(OutDir, "Subscriber.g.cs"), "\n// drift\n");

        var before = SnapshotDir(OutDir);
        VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        var after = SnapshotDir(OutDir);
        Assert.Equal(before, after);
    }

    [Fact]
    public void Codegen_without_committed_output_reports_each_file_as_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        // Never ran gen → OutDir absent → an empty committed tree: every file is missing.
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.Equal(1, r.ExitCode);
        Assert.Null(r.Codegen!.Error);
        Assert.All(r.Codegen.Lines, l => Assert.StartsWith("+ ", l));
    }

    [Fact]
    public void Codegen_with_metadata_that_does_not_load_is_exit1_not_the_usage_exit2()
    {
        // Metadata that does not load is a runtime failure: exit 1, the code gen, fmt,
        // docs and the templates gate already used and every other port uses. It used to
        // share exit 2 with "no --out given", a usage error.
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), """{ "metadata.root": { "children": [ """);
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        Assert.Equal(1, r.ExitCode);
        Assert.Contains("did not load", r.Codegen!.Error);
    }

    // -------------------- the namespace is gen's, never read from the output --------------------
    // verify --codegen regenerates under the namespace gen resolves (--namespace, else the
    // default). Output generated under another namespace is drift, not something to adopt.

    private VerifyCommand.Options CodegenOpts(string? ns) =>
        ns is null
            ? new() { MetadataDir = MetaDir, Generators = GenSuite.Names, OutDir = OutDir, Codegen = true }
            : new() { MetadataDir = MetaDir, Generators = GenSuite.Names, OutDir = OutDir, Codegen = true, Namespace = ns };

    [Fact]
    public void Codegen_output_under_another_namespace_is_drift_without_the_flag()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");

        var r = VerifyCommand.RunSubverbs(CodegenOpts(null));
        Assert.NotEqual(0, r.ExitCode);
        Assert.Contains(r.Codegen!.DriftedFiles, f => f.EndsWith("Subscriber.g.cs"));
    }

    [Fact]
    public void Codegen_with_the_namespace_gen_used_is_clean()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EntityMetadata);
        GenSuite.Run(MetaDir, OutDir, "Acme.Generated");

        var r = VerifyCommand.RunSubverbs(CodegenOpts("Acme.Generated"));
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.Codegen!.Clean, string.Join("; ", r.Codegen!.Lines));
    }

    // -------------------- combining flags aggregates exit --------------------

    [Fact]
    public void Combining_templates_and_codegen_aggregates_max_exit()
    {
        // Templates clean (exit 0) but codegen has no committed output (drift, exit 1).
        WriteTemplate("Hi {{name}}.");
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: true, codegen: true));
        Assert.True(r.RanTemplates);
        Assert.True(r.RanCodegen);
        Assert.Equal(1, r.ExitCode); // max(0, 1)
    }

    // -------------------- naming.columns (ADR-0058; the codegen regen must agree) ----
    // `gen` reads the project's "naming" (`.metaobjects/config.json`) for how a field with
    // no @column becomes a physical column name (see ColumnNamingFlagTests). A `verify
    // --codegen` built with a DIFFERENT PhysicalNaming than gen used regenerates under the
    // wrong rule and convicts every one of them as drift on an otherwise-clean project — the
    // "gate convicts a correct project" pattern this project's own CHANGELOG names as a
    // defect class. `createdAt` carries a case boundary so literal and snake_case produce
    // different committed content (EntityMetadata's `email` field above has none).
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

    /// <summary>Writes <c>.metaobjects/config.json</c> at the project root (<c>_tmp</c>,
    /// the parent of <see cref="MetaDir"/>) declaring <c>naming.columns</c>.</summary>
    private void WriteNamingConfig(string columns)
    {
        var dir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "config.json"),
            $$"""{ "schema_version": 1, "naming": { "columns": "{{columns}}" } }""");
    }

    private VerifyCommand.Options ColumnNamingOpts(ColumnNamingStrategy verifyStrategy) => new()
    {
        MetadataDir = MetaDir,
        // verify --codegen re-runs the SELECTION; there is no default suite to fall
        // back on, so the mechanics tests name the one their fixtures were written for.
        Generators = GenSuite.Names,
        OutDir = OutDir,
        Namespace = "Acme.Generated",
        Codegen = true,
        Naming = new PhysicalNaming(verifyStrategy, TableNamingRule.SnakeCase),
    };

    [Fact]
    public void Codegen_with_matching_column_naming_is_clean()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), ColumnNamingMetadata);
        WriteNamingConfig("literal");
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated", false, GenSuite.Names, null, null);

        var r = VerifyCommand.RunSubverbs(ColumnNamingOpts(ColumnNamingStrategy.Literal));
        Assert.Equal(0, r.ExitCode);
        Assert.True(r.Codegen!.Clean, string.Join("; ", r.Codegen!.Lines));
    }

    [Fact]
    public void Codegen_with_mismatched_column_naming_reports_drift()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), ColumnNamingMetadata);
        WriteNamingConfig("literal");
        GenCommand.Run(MetaDir, OutDir, "Acme.Generated", false, GenSuite.Names, null, null);

        // The discriminating half: a verify blind to the project's naming.columns (accepting
        // it but dropping it, or never reading Options.Naming) would ALSO pass the clean-case
        // test above under its own hardcoded default — only a genuinely MISMATCHED rule proves
        // it is actually threaded into the regen.
        var r = VerifyCommand.RunSubverbs(ColumnNamingOpts(ColumnNamingStrategy.SnakeCase));
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

    // A load failure under --codegen must say WHICH attr on WHICH node. It used to print
    // the error codes alone ("ERR_UNKNOWN_ATTR, ERR_UNKNOWN_ATTR, ...") — 27 of them on one
    // adopter estate — and nothing an author could act on without rebuilding the CLI.
    [Fact]
    public void Codegen_load_failure_names_the_offending_attr_and_node()
    {
        File.Delete(Path.Combine(MetaDir, "meta.ai.json"));
        File.WriteAllText(Path.Combine(MetaDir, "meta.bad.json"), """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Thing", "@noSuchAttr": "x",
            "children": [ { "field.string": { "name": "label" } } ] } }
        ]}}
        """);
        var r = VerifyCommand.RunSubverbs(TemplatesOpts(templates: false, codegen: true));
        // A load failure exits 1 (runtime), as the Node `meta verify` does for the same file.
        Assert.Equal(1, r.ExitCode);
        Assert.NotNull(r.Codegen?.Error);
        Assert.Contains("noSuchAttr", r.Codegen!.Error);
        Assert.Contains("Thing", r.Codegen!.Error);
    }
}
