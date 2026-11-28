using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class MetaEndpointTests
{
    [Fact]
    public void MetaRoutePath_is_the_cross_port_contract_value()
    {
        Assert.Equal("/_meta", MetaEndpoint.MetaRoutePath);
    }

    [Fact]
    public void MetaJson_returns_the_effective_canonical_serialization()
    {
        var root = LoadExtendsFixture();
        Assert.Empty(root.Errors);

        var expected = SerializerJson.CanonicalSerializeEffective(root.Root);
        var actual = MetaEndpoint.MetaJson(root.Root);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void MetaDocsRoutePath_sits_beside_meta() =>
        Assert.Equal("/_meta/docs", MetaEndpoint.MetaDocsRoutePath);

    [Fact]
    public void MetaDocs_body_is_the_model_alone_docs_view()
    {
        var expected = File.ReadAllText(Path.Combine(DocsViewConformanceTests.Corpus(), "model-alone", "expected.json"));
        var root = DocsViewConformanceTests.Load("model-alone");
        Assert.Equal(expected, MetaEndpoint.MetaDocsJson(root));
        var docs = MetaEndpoint.MetaDocs(root);
        Assert.Equal(expected, docs.Body);
        Assert.Equal(MetaEndpoint.MetaDocsETag(expected), docs.ETag);
    }

    [Fact]
    public void MetaDocsETag_is_the_cross_port_value()
    {
        // metaDocsEtag(...) in @metaobjectsdev/runtime-ts (and the Java port) gives these for the same strings.
        Assert.Equal("\"5-4f9f2cab\"", MetaEndpoint.MetaDocsETag("hello"));
        Assert.Equal("\"0-811c9dc5\"", MetaEndpoint.MetaDocsETag(""));
        Assert.Equal("\"7-0579d2da\"", MetaEndpoint.MetaDocsETag("h\u00e9llo \u2713"));
        Assert.Equal("\"2-cb31c4b8\"", MetaEndpoint.MetaDocsETag("\U0001F600"));
    }

    [Fact]
    public void If_none_match_names_the_tag_or_star()
    {
        const string tag = "\"5-4f9f2cab\"";
        Assert.True(MetaEndpoint.ETagMatches(tag, tag));
        Assert.True(MetaEndpoint.ETagMatches("\"x\", W/" + tag, tag));
        Assert.True(MetaEndpoint.ETagMatches("*", tag));
        Assert.False(MetaEndpoint.ETagMatches(null, tag));
        Assert.False(MetaEndpoint.ETagMatches("", tag));
        Assert.False(MetaEndpoint.ETagMatches("\"other\"", tag));
        Assert.True(MetaEndpoint.MetaDocs(DocsViewConformanceTests.Load("model-alone")).Matches("W/\"nope\", *"));
    }

    private static LoadResult LoadExtendsFixture()
    {
        // Load the extends-abstract-base conformance fixture.
        // This fixture has a BaseEntity with inherited fields (id, createdAt)
        // and a Subscriber that extends it, allowing us to verify the effective
        // serialization materializes the super-chain merge.
        var fixtureDir = System.IO.Path.Combine(CorpusRoot.Path, "extends-abstract-base", "input");
        return MetaDataLoader.FromDirectory(fixtureDir);
    }
}
