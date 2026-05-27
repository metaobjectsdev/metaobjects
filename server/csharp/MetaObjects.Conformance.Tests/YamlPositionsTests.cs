// FR5b — YAML source-position tracking through the desugar + parser.
//
// Mirrors test/yaml-positions.test.ts in the TS reference.
//
// Three test tiers:
//   1. Walker — YamlPositionWalker.Walk attaches position-by-key maps to every
//      mapping JsonObject; positions are 1-indexed line/col.
//   2. Desugar — YamlDesugar carries those positions through Rules 1-5
//      (sigil-free attr rename, `[]` strip, scalar-body lift).
//   3. Parser — ParserYaml flattens the per-JsonObject maps into a
//      JSONPath-keyed dictionary; the canonical parser stamps
//      `JsonSource.YamlPosition` on every constructed node.
//
// FR5b finalized 2026-05-27 — all four ports flipped YAML-input source envelopes
// from `JsonSource` (format "json") to `YamlSource` (format "yaml") and the
// yaml-conformance fixtures' format discriminator was mass-updated. The
// envelope continues to carry the optional `YamlPosition` from the desugar.

using System.Text.Json.Nodes;
using MetaObjects.Source;
using YamlDotNet.RepresentationModel;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class YamlPositionsTests
{
    private static TypeRegistry CoreRegistry() =>
        Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    private static JsonNode? WalkYaml(string yaml)
    {
        var stream = new YamlStream();
        using var reader = new StringReader(yaml);
        stream.Load(reader);
        YamlNode root = stream.Documents[0].RootNode;
        return YamlPositionWalker.Walk(root);
    }

    // -----------------------------------------------------------------------
    // Walker layer — position-by-key maps land on every mapping.
    // -----------------------------------------------------------------------

    [Fact]
    public void Walker_AttachesPositionByKeyMapToEveryMapping()
    {
        const string yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n";
        var value = WalkYaml(yaml) as JsonObject;
        Assert.NotNull(value);

        // Root wrapper has a position for "metadata.root".
        Assert.Equal(new YamlPosition(1, 1), YamlPositions.Get(value, "metadata.root"));

        // Root body has positions for "package" and "children".
        var rootBody = value["metadata.root"] as JsonObject;
        Assert.NotNull(rootBody);
        Assert.Equal(new YamlPosition(2, 3), YamlPositions.Get(rootBody, "package"));
        Assert.Equal(new YamlPosition(3, 3), YamlPositions.Get(rootBody, "children"));

        // The single child wrapper points at the "object.entity" line.
        var children = rootBody["children"] as JsonArray;
        Assert.NotNull(children);
        var childWrapper = children[0] as JsonObject;
        Assert.NotNull(childWrapper);
        Assert.Equal(new YamlPosition(4, 7), YamlPositions.Get(childWrapper, "object.entity"));

        // The child body points at the "name" line.
        var childBody = childWrapper["object.entity"] as JsonObject;
        Assert.NotNull(childBody);
        Assert.Equal(new YamlPosition(5, 9), YamlPositions.Get(childBody, "name"));
    }

    [Fact]
    public void Walker_PositionMapIsInvisibleToToJsonString()
    {
        const string yaml = "metadata.root:\n  package: acme\n";
        var value = WalkYaml(yaml) as JsonObject;
        Assert.NotNull(value);
        Assert.NotNull(YamlPositions.GetMap(value));
        // ToJsonString must not surface the side-table.
        string json = value.ToJsonString();
        Assert.DoesNotContain("yamlPosition", json, StringComparison.Ordinal);
        Assert.DoesNotContain("PositionMap", json, StringComparison.Ordinal);
    }

    // -----------------------------------------------------------------------
    // Desugar layer — positions survive the sugar-rule transforms.
    // -----------------------------------------------------------------------

    [Fact]
    public void Desugar_Rule5SigilFreeAttrPreservesPositionUnderAtPrefix()
    {
        const string yaml =
            "object.entity:\n" +
            "  name: Foo\n" +
            "  filterable: true\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "<test>" };
        var result = ParserYaml.ParseYamlCollecting(yaml, opts);
        var body = result.Canonical["object.entity"] as JsonObject;
        Assert.NotNull(body);
        // Rule 5 rewrites bare `filterable` to canonical `@filterable`; the
        // re-keyed position must point at the original `filterable:` line.
        Assert.Equal(new YamlPosition(3, 3), YamlPositions.Get(body, "@filterable"));
        // Reserved structural keys keep their bare form and bare position.
        Assert.Equal(new YamlPosition(2, 3), YamlPositions.Get(body, "name"));
    }

    [Fact]
    public void Desugar_Rule2ScalarBodyInheritsWrapperPositionOnNameSlot()
    {
        // `field.string: sku` lifts to `{ field.string: { name: "sku" } }`.
        // The synthesized `name` has no YAML key of its own, so it inherits
        // the wrapper key's position.
        const string yaml =
            "metadata.root:\n" +
            "  children:\n" +
            "    - field.string: sku\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "<test>" };
        var result = ParserYaml.ParseYamlCollecting(yaml, opts);
        var root = result.Canonical["metadata.root"] as JsonObject;
        Assert.NotNull(root);
        var children = root["children"] as JsonArray;
        Assert.NotNull(children);
        var childWrapper = children[0] as JsonObject;
        Assert.NotNull(childWrapper);
        var childBody = childWrapper["field.string"] as JsonObject;
        Assert.NotNull(childBody);
        // The wrapper key's position is line 3.
        Assert.Equal(new YamlPosition(3, 7), YamlPositions.Get(childWrapper, "field.string"));
        // The synthesized `name` inherits the wrapper key's position.
        Assert.Equal(new YamlPosition(3, 7), YamlPositions.Get(childBody, "name"));
    }

    [Fact]
    public void Desugar_Rule3ArraySuffixPreservesWrapperPositionUnderUnsuffixedKey()
    {
        const string yaml =
            "object.entity:\n" +
            "  name: Foo\n" +
            "  children:\n" +
            "    - field.long[]: weekIds\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "<test>" };
        var result = ParserYaml.ParseYamlCollecting(yaml, opts);
        var body = result.Canonical["object.entity"] as JsonObject;
        Assert.NotNull(body);
        var children = body["children"] as JsonArray;
        Assert.NotNull(children);
        var childWrapper = children[0] as JsonObject;
        Assert.NotNull(childWrapper);
        // The canonical wrapper key is `field.long` (sans `[]`); position
        // points at the YAML `field.long[]:` line.
        Assert.Equal(new YamlPosition(4, 7), YamlPositions.Get(childWrapper, "field.long"));
    }

    // -----------------------------------------------------------------------
    // Parser layer — JsonSource.YamlPosition is populated end-to-end.
    // -----------------------------------------------------------------------

    [Fact]
    public void Parser_EveryYamlLoadedNodeCarriesYamlPositionOnSource()
    {
        const string yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        children:\n" +
            "          - field.string:\n" +
            "              name: id\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "input.yaml" };
        var result = ParserYaml.ParseYaml(yaml, opts);
        Assert.Empty(result.Errors);

        // Root
        var rootSrc = Assert.IsType<YamlSource>(result.Root.Source);
        Assert.Equal("yaml", rootSrc.Format); // FR5b finalized 2026-05-27
        Assert.Equal(new YamlPosition(1, 1), rootSrc.YamlPosition);

        // Object.entity
        var foo = result.Root.OwnChildren()[0];
        Assert.Equal(TYPE_OBJECT, foo.Type);
        var fooSrc = Assert.IsType<YamlSource>(foo.Source);
        Assert.Equal(new YamlPosition(4, 7), fooSrc.YamlPosition);

        // field.string
        var id = foo.OwnChildren()[0];
        Assert.Equal(TYPE_FIELD, id.Type);
        var idSrc = Assert.IsType<YamlSource>(id.Source);
        Assert.Equal(new YamlPosition(7, 13), idSrc.YamlPosition);
    }

    [Fact]
    public void Parser_JsonLoadedNodeHasNoYamlPosition()
    {
        // The JSON parser path doesn't enable the FR5b yaml-format branch;
        // the node's source is the FR5a envelope with YamlPosition == null.
        const string json = """
            { "metadata.root": { "package": "acme", "children": [] } }
            """;
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "input.json" };
        var result = Parser.ParseJson(json, opts);
        Assert.Empty(result.Errors);
        var src = Assert.IsType<JsonSource>(result.Root.Source);
        Assert.Equal("json", src.Format);
        Assert.Null(src.YamlPosition);
    }

    [Fact]
    public void Parser_Rule2ScalarBodyNodeCarriesWrapperKeyPosition()
    {
        const string yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        children:\n" +
            "          - field.string: sku\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "input.yaml" };
        var result = ParserYaml.ParseYaml(yaml, opts);
        Assert.Empty(result.Errors);
        var field = result.Root.OwnChildren()[0].OwnChildren()[0];
        Assert.Equal("sku", field.Name);
        // Wrapper key `field.string:` is on line 7.
        var src = Assert.IsType<YamlSource>(field.Source);
        Assert.Equal(new YamlPosition(7, 13), src.YamlPosition);
    }

    [Fact]
    public void Parser_EmptyBodyNodeStillCarriesWrapperKeyPosition()
    {
        // Per the FR5b spec's "Skip yamlPosition on desugar-synthesized nodes"
        // recommendation: a body with NO keys generates no body-side positions,
        // so the wrapper-key's position is the only surfaced one — and that's
        // what JsonSource.YamlPosition reflects on the resulting node.
        const string yaml =
            "metadata.root:\n" +
            "  children:\n" +
            "    - field.string:\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "input.yaml" };
        var result = ParserYaml.ParseYaml(yaml, opts);
        Assert.Empty(result.Errors);
        var field = result.Root.OwnChildren()[0];
        var src = Assert.IsType<YamlSource>(field.Source);
        Assert.Equal(new YamlPosition(3, 7), src.YamlPosition);
    }

    [Fact]
    public void Parser_ReservedAttrErrorCarriesYamlPosition()
    {
        // Authoring an `@`-prefixed reserved word (e.g. `@isArray`) is a hard
        // ERR_RESERVED_ATTR. The error envelope should include the YAML
        // position pointing at the offending node.
        const string yaml =
            "metadata.root:\n" +
            "  package: acme\n" +
            "  children:\n" +
            "    - object.entity:\n" +
            "        name: Foo\n" +
            "        '@isArray': true\n";
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "input.yaml" };
        var result = ParserYaml.ParseYaml(yaml, opts);
        Assert.NotEmpty(result.Errors);
        var err = result.Errors.FirstOrDefault(e => e.Code == ErrorCode.ERR_RESERVED_ATTR);
        Assert.NotNull(err);
        var src = Assert.IsType<YamlSource>(err!.Envelope);
        // The error fires while the parser is inside object.entity, so the
        // current yamlPosition is the object.entity wrapper-key's line (4).
        Assert.Equal(new YamlPosition(4, 7), src.YamlPosition);
    }
}
