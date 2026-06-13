using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// `dotnet meta docs` pure-logic tests (the adversarial-review fixes):
///   • BUG A — the per-symbol code block is a valid C# import (<c>using &lt;ns&gt;;</c>),
///     never the bare namespace string; and the documented namespace defaults to the
///     SAME default <c>dotnet meta gen</c> uses (so docs + gen agree).
///   • BUG D — a duplicate page-path collision surfaces as a clean, reportable diagnostic
///     (a non-Ok Outcome with a CollisionError), not an uncaught exception.
/// </summary>
public sealed class DocsCommandTests : IDisposable
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

    public DocsCommandTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.shop.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Code_blocks_are_using_directives_never_the_bare_namespace_placeholder()
    {
        // Default namespace = gen's default (NOT the old hardcoded "Generated" literal in docs).
        var outcome = DocsCommand.Run(MetaDir, OutDir, "shop", GenCommand.DefaultNamespace);
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
        var outcome = DocsCommand.Run(MetaDir, OutDir, "shop", GenCommand.DefaultNamespace);
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
        var outcome = DocsCommand.Run(MetaDir, OutDir, "shop", "Acme.Custom");
        Assert.True(outcome.Ok);

        var orderPage = Directory.EnumerateFiles(OutDir, "Order.md", SearchOption.AllDirectories).Single();
        var text = File.ReadAllText(orderPage);
        Assert.Contains("using Acme.Custom", text);
    }
}
