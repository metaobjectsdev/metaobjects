using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// The api reference's code blocks, written by the <c>api-docs</c> entry of a gen run
/// (ADR-0034 Amendment 9; these were `dotnet meta docs` tests before the command was removed):
///   • BUG A — the per-symbol code block is a valid C# import (<c>using &lt;ns&gt;;</c>),
///     never the bare namespace string; and the documented namespace is the one
///     <c>dotnet meta gen</c> generates under (so docs + gen agree).
/// The duplicate page-path collision (BUG D) is covered by ApiDocsRunTests.
/// </summary>
public sealed class ApiDocsNamespaceTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-docs-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "out");

    // An entity + a value + a template.output (so every symbol kind that renders a code
    // block is exercised: Model/DataAccess/Validation/Filter + Payload/Render/Prompt/Parser).
    private const string Metadata = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@filterable": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "OrderSummaryPayload", "children": [
        { "field.string": { "name": "summary", "@required": true } }
      ]}},
      { "template.output": {
        "name": "OrderSummary", "@payloadRef": "OrderSummaryPayload",
        "@textRef": "shop/order-summary", "@format": "json", "@promptStyle": "inline"
      }}
    ]}}
    """;

    public ApiDocsNamespaceTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.shop.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    /// <summary>Gen with only the api-docs entry, its pages under <see cref="OutDir"/>.</summary>
    private CodegenCli.GenOutcome RunDocs(string ns) =>
        CodegenCli.RunGen(MetaDataLoader.FromDirectory(MetaDir), Path.Combine(_tmp, "code"), ns, false,
            [new ApiDocsGenerator { OutDir = OutDir, ProjectName = "shop" }], _tmp);

    [Fact]
    public void Code_blocks_are_using_directives_never_the_bare_namespace_placeholder()
    {
        // Default namespace = gen's default.
        var outcome = RunDocs(GenCommand.DefaultNamespace);
        Assert.True(outcome.Ok, string.Join("; ", outcome.LoadErrors));

        var pages = Directory.EnumerateFiles(OutDir, "*.md", SearchOption.AllDirectories)
            .Select(File.ReadAllText)
            .ToList();
        Assert.NotEmpty(pages);

        var sawCsharpBlock = false;
        foreach (var page in pages)
        {
            // Every csharp code block must be a `using <ns>;` import — never a bare word.
            var idx = 0;
            while ((idx = page.IndexOf("```csharp\n", idx, StringComparison.Ordinal)) >= 0)
            {
                sawCsharpBlock = true;
                var bodyStart = idx + "```csharp\n".Length;
                var bodyEnd = page.IndexOf("\n```", bodyStart, StringComparison.Ordinal);
                var body = page[bodyStart..bodyEnd];
                Assert.StartsWith("using ", body);
                Assert.EndsWith(";", body.Trim());
                idx = bodyEnd;
            }
        }
        Assert.True(sawCsharpBlock, "expected at least one csharp code block across the rendered pages");
    }

    [Fact]
    public void Documented_namespace_defaults_to_the_gen_default_and_appears_in_blocks()
    {
        var outcome = RunDocs(GenCommand.DefaultNamespace);
        Assert.True(outcome.Ok);

        // acme::shop binds to the default namespace + package → "<DefaultNs>.Acme.Shop"-style.
        // Whatever the resolved namespace, the import line must reference it (no naked "Generated"
        // identifier outside a `using ...;`).
        var orderPage = Directory.EnumerateFiles(OutDir, "Order.md", SearchOption.AllDirectories).Single();
        var text = File.ReadAllText(orderPage);
        Assert.Contains("```csharp\nusing ", text);
        Assert.Contains(GenCommand.DefaultNamespace, text);
    }

    [Fact]
    public void Custom_namespace_flows_into_the_import_blocks()
    {
        var outcome = RunDocs("Acme.Custom");
        Assert.True(outcome.Ok);

        var orderPage = Directory.EnumerateFiles(OutDir, "Order.md", SearchOption.AllDirectories).Single();
        var text = File.ReadAllText(orderPage);
        Assert.Contains("using Acme.Custom", text);
    }
}
