// validator.atLeastOne takes no @max. The shared fixture error-validator-at-least-one-max-unknown
// runs under the strict loader, where the attribute is unregistered; this runs the same input
// through the default (non-strict) loader too, which would otherwise keep @max and ignore it.
// Oracle: that fixture's expected-errors.json, exactly one ERR_UNKNOWN_ATTR at the validator,
// under either loader.

using System.IO;
using System.Linq;
using System.Text.Json;
using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class AtLeastOneMaxDefaultLoadTests
{
    private static readonly string Fixture =
        Path.Combine(CorpusRoot.Path, "error-validator-at-least-one-max-unknown");

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AtLeastOne_with_max_is_refused_once(bool strict)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Fixture, "expected-errors.json")));
        var expected = doc.RootElement.GetProperty("errors").EnumerateArray()
            .Select(e => (e.GetProperty("code").GetString(), e.GetProperty("source").GetProperty("jsonPath").GetString()))
            .ToList();

        var sources = Directory.GetFiles(Path.Combine(Fixture, "input"), "*.json")
            .OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => (IMetaDataSource)new FileSource(f)).ToList();
        var result = new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: strict).Load(sources);

        var actual = result.Errors
            .Select(e => ((string?)e.Code.ToString(), (e.Envelope as JsonSource)?.JsonPath))
            .ToList();
        Assert.Equal(expected, actual);
    }
}
