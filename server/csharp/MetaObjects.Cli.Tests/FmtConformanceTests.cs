using System.Text.Json;
using MetaObjects.Cli;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// Cross-port fmt conformance corpus (#304) — fixtures/fmt-conformance/. See
/// that directory's README.md for the fixture format. Mirrors
/// server/typescript/packages/metadata/test/fmt-conformance.test.ts exactly;
/// a mismatch here is a bug in THIS port's formatter or serializer, never in
/// the fixture.
/// </summary>
public class FmtConformanceTests
{
    private static readonly string CorpusDir = ResolveCorpusDir();

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "fmt-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not locate fixtures/fmt-conformance/ by walking up from " + AppContext.BaseDirectory);
    }

    public static IEnumerable<object[]> Fixtures() =>
        Directory.GetDirectories(CorpusDir).OrderBy(d => d, StringComparer.Ordinal).Select(d => new object[] { Path.GetFileName(d) });

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture(string name)
    {
        var dir = Path.Combine(CorpusDir, name);
        var input = File.ReadAllText(Path.Combine(dir, "input.json"));
        var registry = new MetaDataLoader().Registry;
        var result = FmtCommand.FormatFile(input, registry, "input.json");

        var expectedPath = Path.Combine(dir, "expected.json");
        var expectedSkipPath = Path.Combine(dir, "expected-skip.json");

        if (File.Exists(expectedPath))
        {
            Assert.True(result.Ok, result.Message);
            Assert.Equal(File.ReadAllText(expectedPath), result.Text);
        }
        else
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(expectedSkipPath));
            var reason = doc.RootElement.GetProperty("reason").GetString();
            Assert.False(result.Ok);
            Assert.Equal(reason == "overlay", result.Overlay);
        }
    }
}
