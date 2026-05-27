// YamlDesugarTests — focused unit tests for the YAML → canonical desugar (ADR-0006).
//
// Mirrors the targeted unit tests on the TS / Python / Java sibling implementations.
// The fixture-driven YamlConformanceTests cover end-to-end behavior; these tests pin
// the desugar contract directly.

using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class YamlDesugarTests
{
    private static TypeRegistry CoreRegistry() =>
        Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    /// <summary>Run the parser pipeline (YAML → canonical JSON string) and return it.</summary>
    private static string ToCanonicalJson(string yaml)
    {
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "<test>" };
        var result = ParserYaml.ParseYamlCollecting(yaml, opts);
        return result.Canonical.ToJsonString();
    }

    private static YamlParseCollectingResult Desugar(string yaml)
    {
        var registry = CoreRegistry();
        var opts = new ParseOptions(registry) { SourceName = "<test>" };
        return ParserYaml.ParseYamlCollecting(yaml, opts);
    }

    [Fact]
    public void FusedKey_BareTypeResolvesToDefaultSubType()
    {
        // `object` → `object.entity` (CoreTypes designates `entity` as default).
        var yaml = "object:\n  name: Product\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"object.entity\"", json);
    }

    [Fact]
    public void ScalarBody_BecomesNameMap()
    {
        // `field.string: name` → `{ "field.string": { "name": "name" } }`
        var yaml = "field.string: skuCode\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"name\":\"skuCode\"", json);
    }

    [Fact]
    public void ArraySuffix_StripsToIsArray()
    {
        var yaml = "field.long[]: weekIds\n";
        var json = ToCanonicalJson(yaml);
        // Both name and isArray on the inner body.
        Assert.Contains("\"field.long\"", json);
        Assert.Contains("\"name\":\"weekIds\"", json);
        Assert.Contains("\"isArray\":true", json);
        Assert.DoesNotContain("field.long[]", json);
    }

    [Fact]
    public void SigilFreeAttr_GetsAtPrefix()
    {
        // Bare `column: foo` → `@column: foo`.
        var yaml = "field.string:\n  name: sku\n  column: sku_code\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"@column\":\"sku_code\"", json);
    }

    [Fact]
    public void ReservedKey_StaysBare()
    {
        // `package` and `name` are reserved structural keys; they MUST NOT be `@`-prefixed.
        var yaml = "metadata:\n  package: acme\n  children: []\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"package\":\"acme\"", json);
        Assert.DoesNotContain("\"@package\"", json);
    }

    [Fact]
    public void AtPrefixedReservedKey_PassesThroughToCanonicalParser()
    {
        // Author wrote `@isArray: true` — reserved word with sigil. The YAML
        // desugar passes it THROUGH to canonical JSON (it does not pre-empt the
        // diagnostic). The canonical parser is the cross-language owner of the
        // ERR_RESERVED_ATTR check and emits it with the proper FR5a envelope
        // (format=json + parent JSONPath). Mirrors TS yaml-desugar.ts:197-203
        // and Java YamlDesugar.java:340-349.
        var yaml = "object.entity:\n  name: Product\n  \"@isArray\": true\n";
        var result = Desugar(yaml);
        // Desugar itself does NOT emit ERR_RESERVED_ATTR.
        Assert.DoesNotContain(result.Errors,
            e => e.Code == ErrorCode.ERR_RESERVED_ATTR);
        // The @-prefixed reserved key survives in the canonical JSON, where the
        // downstream canonical parser will flag it.
        var json = result.Canonical.ToJsonString();
        Assert.Contains("\"@isArray\"", json);
    }

    [Fact]
    public void MixedBareAndAtPrefixed_BothPreserved()
    {
        // `objectRef` (sigil-free) gets `@`; `@storage` (sigil) stays.
        var yaml = "field.object:\n  name: addr\n  \"@objectRef\": Address\n  storage: flattened\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"@objectRef\":\"Address\"", json);
        Assert.Contains("\"@storage\":\"flattened\"", json);
    }

    [Fact]
    public void Children_RecursedAndDesugared()
    {
        var yaml = """
        metadata:
          children:
            - object.entity:
                name: Product
                children:
                  - field.long: id
        """;
        var json = ToCanonicalJson(yaml);
        // The inner field.long has its scalar body lowered to `{ name: "id" }`.
        Assert.Contains("\"field.long\":{\"name\":\"id\"}", json);
    }

    [Fact]
    public void EmptyBody_BecomesEmptyMap()
    {
        // A trailing `:` with no content produces a null-bodied node which lowers to `{}`.
        var yaml = "field.string:\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"field.string\":{}", json);
    }

    [Fact]
    public void EnumValues_NumberInListIsCoercionError()
    {
        // field.enum's @values is declared stringarray in C# v1. A bare int in the
        // list is the YAML coercion the D2 guard catches.
        var yaml = """
        field.enum:
          name: status
          values: ["DRAFT", 42, "PUBLISHED"]
        """;
        var result = Desugar(yaml);
        Assert.Contains(result.Errors,
            e => e.Code == ErrorCode.ERR_YAML_COERCION);
    }

    [Fact]
    public void EnumValues_BareStringShorthand_NoCoercion()
    {
        // Single-string shorthand for a stringarray attr is the legitimate authoring form.
        var yaml = """
        field.enum:
          name: status
          values: DRAFT
        """;
        var result = Desugar(yaml);
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void Bom_StrippedBeforeYamlParse()
    {
        // UTF-8 BOM at the very start must not break parsing.
        var yaml = "﻿object:\n  name: Product\n";
        var json = ToCanonicalJson(yaml);
        Assert.Contains("\"object.entity\"", json);
    }
}
