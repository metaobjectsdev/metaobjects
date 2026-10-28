// `dotnet meta init --with-docs` lists the api-docs generator in the scaffolded generator list.
// Without the flag nothing changes.

using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class InitWithDocsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-init-docs-" + Guid.NewGuid().ToString("N"));
    private string List => File.ReadAllText(Path.Combine(_root, "codegen", "Generators.cs"));

    public InitWithDocsTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    [Fact]
    public void With_docs_lists_the_api_docs_generator_and_says_how_it_is_drift_checked()
    {
        var lines = InitCommand.Run(_root, withDocs: true);

        Assert.Contains("new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir = \"docs/csharp\"", List);
        Assert.DoesNotContain("//   new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir", List.Replace("//   new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir = \"docs/csharp\", ProjectName = \"shop\" },", ""));
        Assert.Contains("csharp", string.Join("\n", lines));
        Assert.Contains("outDir", string.Join("\n", lines));
    }

    [Fact]
    public void Without_the_flag_the_list_is_unchanged()
    {
        InitCommand.Run(_root);

        Assert.Equal(CodegenScaffold.GeneratorsCs([]), List);
    }

    [Fact]
    public void With_docs_never_edits_an_existing_list_and_prints_the_entry_to_add()
    {
        InitCommand.Run(_root);
        var before = List;

        var lines = InitCommand.Run(_root, withDocs: true);

        Assert.Equal(before, List);
        Assert.Contains(lines, l => l.Contains("ApiDocsGenerator { OutDir = \"docs/csharp\""));
    }
}
