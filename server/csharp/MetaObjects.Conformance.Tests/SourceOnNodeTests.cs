// FR5a / ADR-0009 — MetaData.Source provenance unit tests.
//
// Covers the four cases mandated by the FR §"Per-port unit tests":
//   1. Constructor stores source (default CodeSource for programmatic construction).
//   2. SetSource overwrites; honors the frozen-guard.
//   3. Parser populates JsonSource on every node during the tree walk.
//   4. Canonical-JSON serializer OMITS source from its output.

using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SourceOnNodeTests
{
    [Fact]
    public void Programmatic_construction_defaults_to_CodeSource()
    {
        var node = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
        Assert.IsType<CodeSource>(node.Source);
        Assert.Equal("code", node.Source.Format);
    }

    [Fact]
    public void SetSource_replaces_provenance_and_honors_freeze()
    {
        var node = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
        node.SetSource(new JsonSource(new[] { "fixtures/foo.json" }, "$"));
        Assert.IsType<JsonSource>(node.Source);
        var js = (JsonSource)node.Source;
        Assert.Equal("fixtures/foo.json", js.Files[0]);
        Assert.Equal("$", js.JsonPath);

        node.Freeze();
        Assert.Throws<InvalidOperationException>(() =>
            node.SetSource(new CodeSource("after-freeze")));
    }

    [Fact]
    public void Parser_populates_JsonSource_on_every_node()
    {
        const string json = """
            { "metadata.root": {
                "package": "demo",
                "children": [
                  { "object.entity": {
                      "name": "Widget",
                      "children": [
                        { "field.string": { "name": "id" } },
                        { "identity.primary": { "@fields": ["id"] } }
                      ]
                  } }
                ]
            } }
            """;

        var registry = Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);
        var result = MetaDataLoader.FromString(json, MetaDataFormat.Json, registry);
        Assert.Empty(result.Errors);

        var root = result.Root;
        Assert.IsType<JsonSource>(root.Source);
        var rootJs = (JsonSource)root.Source;
        // The wrapper key `metadata.root` contains a literal `.`, so canonical
        // form uses bracket-quoted notation per ADR-0009 §"Path format".
        Assert.Equal("$['metadata.root']", rootJs.JsonPath);

        var entity = root.OwnChildren().First(c => c.Type == TYPE_OBJECT);
        Assert.IsType<JsonSource>(entity.Source);
        var entityJs = (JsonSource)entity.Source;
        // `children` is identifier-safe → dot; `object.entity` carries a dot → bracket.
        Assert.Equal(
            "$['metadata.root'].children[0]['object.entity']",
            entityJs.JsonPath);

        var idField = entity.OwnChildren().First(c => c.Type == TYPE_FIELD);
        var idJs = (JsonSource)idField.Source;
        Assert.Equal(
            "$['metadata.root'].children[0]['object.entity'].children[0]['field.string']",
            idJs.JsonPath);
    }

    [Fact]
    public void Canonical_serializer_omits_source_from_output()
    {
        const string json = """
            { "metadata.root": {
                "package": "demo",
                "children": [
                  { "object.entity": {
                      "name": "Widget",
                      "children": [
                        { "field.string": { "name": "id" } },
                        { "identity.primary": { "@fields": ["id"] } }
                      ]
                  } }
                ]
            } }
            """;

        var registry = Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);
        var result = MetaDataLoader.FromString(json, MetaDataFormat.Json, registry);
        Assert.Empty(result.Errors);

        string canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.DoesNotContain("\"source\"", canonical);
        Assert.DoesNotContain("\"jsonPath\"", canonical);
        Assert.DoesNotContain("\"format\"", canonical);
    }

    [Fact]
    public void JsonSource_files_carries_the_source_id()
    {
        const string json = """{ "metadata.root": { "package": "demo" } }""";
        var loader = new MetaDataLoader(Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]));
        var result = loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "metaobjects/demo.json"),
        });
        Assert.Empty(result.Errors);
        var js = (JsonSource)result.Root.Source;
        Assert.Single(js.Files);
        Assert.Equal("metaobjects/demo.json", js.Files[0]);
    }

    [Fact]
    public void Parse_error_envelope_carries_JsonSource()
    {
        // Trigger ERR_UNKNOWN_TYPE: child wrapper key references an unregistered type.
        const string json = """
            { "metadata.root": {
                "children": [
                  { "object.entity": {
                      "name": "X",
                      "children": [
                        { "fooBar.baz": { "name": "broken" } }
                      ]
                  } }
                ]
            } }
            """;

        var loader = new MetaDataLoader(Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]));
        var result = loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "test.json"),
        });

        Assert.NotEmpty(result.Errors);
        var err = result.Errors.First(e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.NotNull(err.Envelope);
        var js = Assert.IsType<JsonSource>(err.Envelope);
        Assert.Equal(new[] { "test.json" }, js.Files);
        Assert.Contains("['fooBar.baz']", js.JsonPath);
    }
}
