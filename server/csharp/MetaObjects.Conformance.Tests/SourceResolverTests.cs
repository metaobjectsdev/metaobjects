using System.Collections.Generic;
using System.IO;
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Focused unit coverage for <see cref="SourceResolver.ResolveSources"/> shapes
/// not gated by the shared <c>source-resolution-conformance</c> corpus.
/// </summary>
public sealed class SourceResolverTests
{
    // F12 — Pass 2 resolves in CONTENT order (ordinal path-string sort), not
    // declared order, mirroring the TypeScript reference's `orderedPathSpecs`
    // (`sources.ts`: kind-validated, then sorted by `JSON.stringify(spec)`,
    // which for a validated `path`-only spec reduces to the path string alone
    // — verified empirically: `resolveSources(dir, [{path:"zzz-missing"},
    // {path:"aaa-missing"}])` names "aaa-missing", the content-first one, even
    // though "zzz-missing" is declared first). With BOTH paths unresolvable,
    // only a port that content-sorts before Pass 2 names "aaa-missing" here;
    // a declared-order implementation names "zzz-missing" instead.
    [Fact]
    public void TwoUnresolvablePaths_ReportsTheContentFirstOne()
    {
        var root = Path.Combine(Path.GetTempPath(), "source-resolver-order-" + System.Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var specs = new List<IReadOnlyDictionary<string, string>>
            {
                new Dictionary<string, string> { ["path"] = "zzz-missing" },
                new Dictionary<string, string> { ["path"] = "aaa-missing" },
            };
            var ex = Assert.Throws<MetaModelException>(() => SourceResolver.ResolveSources(root, specs));
            Assert.Contains("aaa-missing", ex.Message);
            Assert.DoesNotContain("zzz-missing", ex.Message);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
