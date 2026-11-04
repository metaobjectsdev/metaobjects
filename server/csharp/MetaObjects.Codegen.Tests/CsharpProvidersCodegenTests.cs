// `csharp.providers` through CodegenCli.Run — the entry an owned codegen/Program.cs calls, and the
// one `dotnet meta gen` / `verify --codegen` hand off to. The vocabulary is loaded strictly.

using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

[Collection("Console")]
public class CsharpProvidersCodegenTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-providers-" + Guid.NewGuid().ToString("N"));
    private string Meta => Path.Combine(_root, "metaobjects");
    private string Out => Path.Combine(_root, "gen");

    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Contact", "children": [
            { "field.string": { "name": "name", "@searchable": true } },
            { "layout.picker": { "name": "contactPicker", "@displayField": "name" } }
          ]}}
        ]}}
        """;

    private sealed class OneFile : IGenerator
    {
        public string Name => "one-file";
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [new EmittedFile("ok.txt", "ok\n")];
    }

    public CsharpProvidersCodegenTests()
    {
        Directory.CreateDirectory(Meta);
        File.WriteAllText(Path.Combine(Meta, "meta.acme.json"), Model);
    }

    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static string VocabularyDll
    {
        get
        {
            var baseDir = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            var root = baseDir.Parent!.Parent!.Parent!.Parent!.FullName;
            return Path.Combine(root, "MetaObjects.TestVocabulary", "bin", baseDir.Parent!.Name, baseDir.Name, "MetaObjects.TestVocabulary.dll");
        }
    }

    private void WriteConfig(bool withProviders)
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        var providers = withProviders
            ? ", \"providers\": [ { \"assembly\": \"" + VocabularyDll.Replace("\\", "\\\\") +
              "\", \"type\": \"MetaObjects.TestVocabulary.TestVocabularyProvider\" } ]"
            : "";
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"),
            "{ \"schema_version\": 1, \"csharp\": { \"namespace\": \"Acme\"" + providers + " } }");
    }

    private static int Quiet(Func<int> run)
    {
        var (o, e) = (Console.Out, Console.Error);
        Console.SetOut(TextWriter.Null); Console.SetError(TextWriter.Null);
        try { return run(); } finally { Console.SetOut(o); Console.SetError(e); }
    }

    [Fact]
    public void Gen_and_verify_codegen_load_the_custom_vocabulary_when_listed()
    {
        WriteConfig(withProviders: true);
        Assert.Equal(0, Quiet(() => CodegenCli.Run(["gen", Meta, "--out", Out], [new OneFile()])));
        Assert.True(File.Exists(Path.Combine(Out, "ok.txt")));
        Assert.Equal(0, Quiet(() => CodegenCli.Run(["verify", "--codegen", Meta, "--out", Out], [new OneFile()])));
    }

    [Fact]
    public void Gen_fails_on_the_custom_vocabulary_without_the_provider()
    {
        WriteConfig(withProviders: false);
        var err = new StringWriter();
        var prev = Console.Error;
        Console.SetError(err);
        try { Assert.NotEqual(0, CodegenCli.Run(["gen", Meta, "--out", Out], [new OneFile()])); }
        finally { Console.SetError(prev); }
        Assert.Contains("ERR_UNKNOWN_SUBTYPE", err.ToString());
        Assert.False(File.Exists(Path.Combine(Out, "ok.txt")));
    }
}
