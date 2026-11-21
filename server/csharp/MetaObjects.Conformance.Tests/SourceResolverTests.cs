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

    /// <summary>
    /// A genuinely unknown top-level key resolves normally here: it is never rejected,
    /// because a newer `meta` may have just written it. Since 1.3.0 this port warns about
    /// it, as TypeScript does (NeutralConfigUnknownKeyTests); the resolution itself is
    /// unchanged.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT a shared corpus case: a shared case asserts one outcome and
    /// the correct outcome differs by port, so adding one could only be done by making
    /// some port wrong. This is the tolerant half.
    /// </remarks>
    [Fact]
    public void AnUnknownTopLevelConfigKey_IsIgnored_NotRejected()
    {
        var root = Path.Combine(Path.GetTempPath(), "source-resolver-unknownkey-" + System.Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var model = Path.Combine(root, "model");
            Directory.CreateDirectory(model);
            File.WriteAllText(Path.Combine(model, "meta.a.json"), "{\"metadata.root\":{\"children\":[]}}");

            var dotMo = Path.Combine(root, ".metaobjects");
            Directory.CreateDirectory(dotMo);
            File.WriteAllText(Path.Combine(dotMo, "config.json"),
                "{\"schema_version\":1,\"sources\":[{\"path\":\"model\"}],\"foo\":1}");

            var resolved = SourceResolver.ResolveCollection(root);

            Assert.Single(resolved);
            Assert.Equal(Path.Combine(model, "meta.a.json"), resolved[0]);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
