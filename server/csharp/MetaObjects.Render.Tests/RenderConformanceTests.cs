using System.Text.Json;
using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Render-conformance corpus runner — the cross-language render guarantee.
/// Each fixture dir under fixtures/render-conformance/ holds:
///   meta.json          { "format": "&lt;RenderFormat&gt;" }
///   template.mustache  the entry template
///   partials/*.mustache  optional partials, referenced as `partials/&lt;name&gt;`
///   payload.json       the render payload (pre-formatted primitives)
///   expected.txt       byte-exact expected output
/// The same shared corpus is rendered byte-for-byte identically by TS and C#.
/// Mirrors typescript/packages/render/test/render-conformance.test.ts.
/// </summary>
public class RenderConformanceTests
{
    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "render-conformance")))
        {
            var parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/render-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "render-conformance");
    }

    public static IEnumerable<object[]> Fixtures()
    {
        var corpus = CorpusRoot();
        foreach (var dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
            yield return new object[] { Path.GetFileName(dir) };
    }

    private static InMemoryProvider ProviderFromPartials(string dir)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var pdir = Path.Combine(dir, "partials");
        if (Directory.Exists(pdir))
        {
            foreach (var f in Directory.GetFiles(pdir, "*.mustache"))
            {
                var name = Path.GetFileNameWithoutExtension(f);
                map[$"partials/{name}"] = File.ReadAllText(f);
            }
        }
        return new InMemoryProvider(map);
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void RenderMatchesExpected(string name)
    {
        var dir = Path.Combine(CorpusRoot(), name);

        var metaRaw = File.ReadAllText(Path.Combine(dir, "meta.json"));
        var format = JsonDocument.Parse(metaRaw).RootElement.GetProperty("format").GetString()!;
        var template = File.ReadAllText(Path.Combine(dir, "template.mustache"));
        var payload = JsonPayload.Parse(File.ReadAllText(Path.Combine(dir, "payload.json")));
        var expected = File.ReadAllText(Path.Combine(dir, "expected.txt"));
        var provider = ProviderFromPartials(dir);

        var actual = Renderer.Render(new RenderRequest
        {
            Template = template,
            Payload = payload,
            Provider = provider,
            Format = format,
        });

        Assert.Equal(expected, actual);

        // Determinism: identical across runs.
        var again = Renderer.Render(new RenderRequest
        {
            Template = template,
            Payload = payload,
            Provider = provider,
            Format = format,
        });
        Assert.Equal(actual, again);
    }
}
