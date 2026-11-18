using MetaObjects.Cli;
using MetaObjects.Config;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// `csharp.providers` in .metaobjects/config.json: a project's own IMetaDataTypeProvider, loaded by
/// path, composes into EVERY metadata-loading entry point (gen/verify/fmt/field-lint), strictly.
/// The test provider lives in MetaObjects.TestVocabulary (built, not referenced, by this project).
/// </summary>
public sealed class CsharpProvidersTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-providers-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Contact", "children": [
        { "field.string": { "name": "name", "@searchable": true } },
        { "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
      ]}}
    ]}}
    """;

    public CsharpProvidersTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    /// <summary>Path of the built test vocabulary dll (sibling project's output).</summary>
    internal static string VocabularyDll
    {
        get
        {
            // <repo>/MetaObjects.Cli.Tests/bin/<cfg>/net8.0/ -> <repo>/MetaObjects.TestVocabulary/bin/<cfg>/net8.0/
            var baseDir = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            var tfm = baseDir.Name; var cfg = baseDir.Parent!.Name;
            var root = baseDir.Parent!.Parent!.Parent!.Parent!.FullName;
            return Path.Combine(root, "MetaObjects.TestVocabulary", "bin", cfg, tfm, "MetaObjects.TestVocabulary.dll");
        }
    }

    private void WriteConfig(string csharpBlock)
    {
        Directory.CreateDirectory(Path.Combine(_tmp, ".metaobjects"));
        File.WriteAllText(Path.Combine(_tmp, ".metaobjects", "config.json"),
            "{ \"schema_version\": 1, \"csharp\": " + csharpBlock + " }");
    }

    private static string Esc(string s) => s.Replace("\\", "\\\\");

    private void WriteProviderConfig(string type = "MetaObjects.TestVocabulary.TestVocabularyProvider", string? assembly = null) =>
        WriteConfig("{ \"providers\": [ { \"assembly\": \"" + Esc(assembly ?? VocabularyDll) + "\", \"type\": \"" + type + "\" } ] }");

    private ResolvedMetadata Resolve() => MetadataLocation.Resolve(null, _tmp);

    // -- loading ---------------------------------------------------------------------------

    [Fact]
    public void Listed_provider_loads_the_custom_vocabulary_strictly()
    {
        WriteProviderConfig();
        var load = Resolve().Load(strict: true);
        Assert.Empty(load.Errors);
    }

    [Fact]
    public void Without_the_provider_the_same_metadata_fails_strict()
    {
        WriteConfig("{ \"outDir\": \"gen\" }");
        var codes = Resolve().Load(strict: true).Errors.Select(e => e.Code).ToList();
        Assert.Contains(ErrorCode.ERR_UNKNOWN_SUBTYPE, codes);
        Assert.Contains(ErrorCode.ERR_UNKNOWN_ATTR, codes);
    }

    [Fact]
    public void The_assembly_path_is_resolved_against_the_directory_holding_dot_metaobjects()
    {
        var rel = Path.GetRelativePath(_tmp, VocabularyDll);
        WriteProviderConfig(assembly: rel);
        Assert.Empty(Resolve().Load(strict: true).Errors);
    }

    [Fact]
    public void An_explicit_metadata_dir_reads_the_providers_of_the_project_holding_it()
    {
        WriteProviderConfig();
        var other = Path.Combine(Path.GetTempPath(), "meta-providers-cwd-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(other);
        try { Assert.Empty(MetadataLocation.Resolve(MetaDir, other).Load(strict: true).Errors); }
        finally { Directory.Delete(other, recursive: true); }
    }

    [Fact]
    public void Registry_composes_with_FromDirectory_for_a_programmatic_host()
    {
        WriteProviderConfig();
        var registry = Resolve().Registry();
        Assert.Empty(MetaDataLoader.FromDirectory(MetaDir, registry, strict: true).Errors);
    }

    // -- every entry point -----------------------------------------------------------------

    [Fact]
    public void Verify_templates_gate_uses_the_providers()
    {
        WriteProviderConfig();
        var providers = Resolve().Providers;
        var tpl = Path.Combine(_tmp, "templates"); Directory.CreateDirectory(tpl);

        var with = VerifyCommand.RunSubverbs(new VerifyCommand.Options
            { MetadataDir = MetaDir, TemplatesRoot = tpl, Templates = true, Providers = providers });
        Assert.Empty(with.Templates!.LoadErrors);

        var without = VerifyCommand.RunSubverbs(new VerifyCommand.Options
            { MetadataDir = MetaDir, TemplatesRoot = tpl, Templates = true });
        Assert.Contains(ErrorCode.ERR_UNKNOWN_SUBTYPE.ToString(), without.Templates!.LoadErrors);

        Assert.Empty(VerifyCommand.Run(MetaDir, tpl, providers: providers).LoadErrors);
        Assert.Contains(ErrorCode.ERR_UNKNOWN_SUBTYPE.ToString(), VerifyCommand.Run(MetaDir, tpl).LoadErrors);
    }

    [Fact]
    public void Verify_requirement_gate_loads_with_the_providers()
    {
        WriteProviderConfig();
        var opts = new VerifyCommand.Options { MetadataDir = MetaDir, Providers = Resolve().Providers };
        var output = new StringWriter();
        Assert.Equal(0, VerifyCommand.RunRequirementGate(opts, false, output, false));
        Assert.DoesNotContain("load error", output.ToString());

        var bare = new StringWriter();
        Assert.Equal(1, VerifyCommand.RunRequirementGate(new VerifyCommand.Options { MetadataDir = MetaDir }, false, bare, false));
        Assert.Contains("ERR_UNKNOWN_SUBTYPE", bare.ToString());
    }

    [Fact]
    public void Verify_codegen_gate_loads_with_the_providers()
    {
        WriteProviderConfig();
        var opts = new VerifyCommand.Options
        {
            MetadataDir = MetaDir, OutDir = Path.Combine(_tmp, "generated"), Codegen = true, Providers = Resolve().Providers,
        };
        var r = VerifyCommand.RunSubverbs(opts);
        Assert.False(r.LoadFailureReported);

        var bare = VerifyCommand.RunSubverbs(new VerifyCommand.Options
            { MetadataDir = MetaDir, OutDir = Path.Combine(_tmp, "generated"), Codegen = true });
        Assert.True(bare.LoadFailureReported);
    }

    [Fact]
    public void Fmt_loads_and_formats_with_the_providers()
    {
        WriteProviderConfig();
        var result = FmtCommand.Run(Resolve(), check: true, strict: true);
        Assert.Null(result.Fatal);

        File.Delete(Path.Combine(_tmp, ".metaobjects", "config.json"));
        var bare = FmtCommand.Run(Resolve(), check: true, strict: true);
        Assert.NotNull(bare.Fatal);
        Assert.Contains("picker", bare.Fatal!);
    }

    [Fact]
    public void Field_lint_loads_with_the_providers()
    {
        WriteProviderConfig();
        // A repeated field name: the advisory scan only gets to report it if the model LOADS.
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Contact", "children": [
            { "field.string": { "name": "name", "@searchable": true } },
            { "field.string": { "name": "name" } },
            { "layout.picker": { "name": "contactPicker" } }
          ]}}
        ]}}
        """);
        var resolved = Resolve();
        var with = new StringWriter();
        FieldLint.RunAdvisory(resolved.Directory, resolved.Files, resolved.Libraries, with, resolved.Imports, resolved.Providers);
        Assert.Contains("authoring warning", with.ToString());

        var without = new StringWriter();
        FieldLint.RunAdvisory(resolved.Directory, resolved.Files, resolved.Libraries, without, resolved.Imports);
        Assert.Equal("", without.ToString());
    }

    // -- config errors ---------------------------------------------------------------------

    private MetaModelException Refusal()
        => Assert.Throws<MetaModelException>(() => Resolve());

    [Fact]
    public void Missing_assembly_says_build_it_first_and_names_the_key()
    {
        WriteProviderConfig(assembly: "vocabulary/bin/Debug/net8.0/Nope.dll");
        var ex = Refusal();
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
        Assert.Contains("csharp.providers", ex.Message);
        Assert.Contains("Nope.dll", ex.Message);
        Assert.Contains("Build the vocabulary project first", ex.Message);
    }

    [Theory]
    [InlineData("Acme.Missing.Provider", "was not found")]
    [InlineData("MetaObjects.TestVocabulary.NotAProvider", "IMetaDataTypeProvider")]
    [InlineData("MetaObjects.TestVocabulary.NeedsArgsProvider", "parameterless constructor")]
    public void Bad_type_is_refused_with_an_actionable_message(string type, string fragment)
    {
        WriteProviderConfig(type);
        var ex = Refusal();
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
        Assert.Contains("csharp.providers", ex.Message);
        Assert.Contains(fragment, ex.Message);
    }

    [Theory]
    [InlineData("{ \"providers\": \"x\" }", "must be an array")]
    [InlineData("{ \"providers\": [ \"x\" ] }", "must be an object")]
    [InlineData("{ \"providers\": [ { \"assembly\": \"a.dll\" } ] }", "needs both")]
    [InlineData("{ \"providers\": [ { \"assembly\": \"a.dll\", \"type\": \"T\", \"extra\": 1 } ] }", "unknown key \"extra\"")]
    [InlineData("{ \"providers\": [ { \"assembly\": \"\", \"type\": \"T\" } ] }", "non-empty string")]
    public void Malformed_provider_entries_are_refused(string block, string fragment)
    {
        WriteConfig(block);
        var ex = Refusal();
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
        Assert.Contains(fragment, ex.Message);
    }
}
