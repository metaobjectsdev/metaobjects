using System.Text.Json;
using MetaObjects.Cli;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// Cross-port model-lint conformance corpus — fixtures/model-lint-conformance/ (the overlay,
/// node-name and deprecated-reference lints). See that directory's README.md for the fixture
/// format. Every case is LOADED strict first, so "this loads with no error today" is proven by the
/// fixture, and only then linted. A mismatch here is a bug in THIS port's lint, never in the fixture.
/// </summary>
public class ModelLintConformanceTests
{
    private static readonly string CorpusDir = ResolveCorpusDir();

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "model-lint-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not locate fixtures/model-lint-conformance/ by walking up from " + AppContext.BaseDirectory);
    }

    public static IEnumerable<object[]> Fixtures() =>
        Directory.GetDirectories(CorpusDir).OrderBy(d => d, StringComparer.Ordinal).Select(d => new object[] { Path.GetFileName(d) });

    [Fact]
    public void Discovers_the_corpus() => Assert.NotEmpty(Fixtures());

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture(string name)
    {
        var input = Path.Combine(CorpusDir, name, "input");
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CorpusDir, name, "expected.json")));
        var expected = doc.RootElement.GetProperty("findings").EnumerateArray()
            .Select(f => (f.GetProperty("code").GetString()!, f.GetProperty("path").GetString()!, f.GetProperty("message").GetString()!))
            .Order().ToList();

        var load = MetaDataLoader.FromDirectory(input, strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        // The overlay lint names each file relative to input/, in the order the loader reads them.
        var sources = Directory.GetFiles(input).OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => (IMetaDataSource)new FileSource(f, Path.GetFileName(f)));
        var actual = OverlayLint.Lint(sources)
            .Concat(NameLint.Lint(load.Root))
            .Concat(DeprecationLint.Lint(load.Root))
            .Select(f => (f.Code, f.Path, f.Message))
            .Order().ToList();

        Assert.Equal(expected, actual);
    }
}
