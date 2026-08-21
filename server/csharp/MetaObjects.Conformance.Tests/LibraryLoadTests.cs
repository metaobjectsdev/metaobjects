using MetaObjects.Library;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// The C# port can load the MetaObjects-shipped library packages, so
/// <c>extends: "metaobjects::ai::LlmCallBase"</c> resolves — port parity with TypeScript,
/// Python and Java (#332 / #333).
///
/// <para>The NEGATIVE arm is the half that proves the opt-in is doing the work: without it the
/// same model must still fail. A positive-only test keeps passing if the library is quietly
/// made unconditional, which would put its top-level nodes into the model — and the generated
/// output, and the docs — of every project that never asked for one.</para>
/// </summary>
public class LibraryLoadTests
{
    private const string Model = """
        {
          "metadata.root": {
            "package": "acme::trace",
            "children": [
              { "object.entity": {
                  "name": "AgentCall",
                  "extends": "metaobjects::ai::LlmCallBase",
                  "children": [
                    { "source.rdb": { "@table": "agent_call" } },
                    { "identity.primary": { "name": "pk", "@fields": ["spanId"] } }
                  ]
              } }
            ]
          }
        }
        """;

    private static string WriteModel()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-library-load-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "trace.json"), Model);
        return dir;
    }

    [Fact]
    public void LibrariesOptInMakesTheShippedBaseResolvable()
    {
        var dir = WriteModel();
        try
        {
            var result = MetaDataLoader.FromDirectory(dir, new[] { "ai" });

            Assert.Empty(result.Errors);
            // The library's own nodes are in the model...
            Assert.NotNull(result.Root.Children()
                .FirstOrDefault(c => c.ResolutionKey() == "metaobjects::ai::LlmCallBase"));
            // ...and the project's entity resolves its super against them, inheriting the fields.
            var agentCall = result.Root.Children()
                .FirstOrDefault(c => c.ResolutionKey() == "acme::trace::AgentCall");
            Assert.NotNull(agentCall);
            // ADR-0039: the RESOLVING accessor — traceId is inherited, never declared here.
            Assert.Contains(agentCall!.Children(), c => c.Name == "traceId");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void WithoutTheOptInTheSameModelDoesNotResolve()
    {
        var dir = WriteModel();
        try
        {
            var result = MetaDataLoader.FromDirectory(dir);

            Assert.Null(result.Root.Children()
                .FirstOrDefault(c => c.ResolutionKey() == "metaobjects::ai::LlmCallBase"));
            // Named, not merely non-empty: a bare "it failed" assertion would pass if the model
            // failed for any unrelated reason, which would prove nothing about whether the
            // opt-in is what supplies the base.
            Assert.Contains(result.Errors, e => e.Message.Contains("LlmCallBase"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void AnUnknownPackageContributesNoSourcesAndIsNotAnError()
    {
        // The cross-port contract for the PROGRAMMATIC door. A caller asking for a package this
        // version does not ship must still be able to load its own metadata; the callers that
        // read the name from a human validate first.
        Assert.Empty(LibrarySources.Resolve(new[] { "nosuchpackage" }));
        Assert.Empty(LibrarySources.Resolve(null));
    }

    [Fact]
    public void KnownPackagesNamesWhatThisBuildShips()
    {
        var known = LibrarySources.KnownPackages();
        Assert.Contains("ai", known);
        Assert.Equal(known.OrderBy(k => k, StringComparer.Ordinal).ToList(), known);
    }

    /// <summary>
    /// The freshness gate: the embed must equal the canonical tree byte for byte.
    ///
    /// <para>Skipped per-ref when the repo-root <c>library/</c> tree is unreachable — the
    /// published-package case, where there is nothing to compare against. In a checkout, which
    /// is where this test actually runs, the comparison is live.</para>
    /// </summary>
    [Fact]
    public void TheEmbedIsByteIdenticalToTheCanonicalTree()
    {
        foreach (var (reference, embedded) in EmbeddedLibrary.Content)
        {
            var onDisk = LibrarySources.OnDiskContent(reference);
            if (onDisk is null) continue; // not a checkout — nothing to compare
            Assert.True(onDisk == embedded,
                $"EmbeddedLibrary is stale for ref \"{reference}\" — "
                + "run: bun run scripts/generate-embedded-library.ts");
        }
    }
}
