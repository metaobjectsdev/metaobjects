// Issue195OriginValidationTests — per-capability origin validation for the four
// #195 projection read-model origin capabilities (origin.aggregate any|all|collect,
// origin.computed, origin.first).
//
// C# parity port of the TS reference test suite:
//   server/typescript/packages/metadata/test/loader-origin-validation.test.ts
//     (the "#195 …" describe blocks — 20 cases).
//
// All rules emit ERR_INVALID_ORIGIN except the two dedicated codes
// (ERR_COMPUTED_TYPE_MISMATCH, ERR_UNKNOWN_EXPR_NODE). Every model is loaded
// through the full loader pipeline so the origin-path validation pass runs.

using System.Linq;
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Issue195OriginValidationTests
{
    private static LoadResult LoadInline(string json)
    {
        var src = new InMemoryStringSource(json, id: "inline.json");
        return new MetaDataLoader().Load([src]);
    }

    private static bool HasError(LoadResult r, ErrorCode code, string substr)
        => r.Errors.Any(e => e.Code == code && e.Message.Contains(substr, System.StringComparison.Ordinal));

    private static bool HasErrorAny(LoadResult r, ErrorCode code, params string[] substrs)
        => r.Errors.Any(e => e.Code == code
            && substrs.Any(s => e.Message.Contains(s, System.StringComparison.Ordinal)));

    // A Session/Turn graph + a projection carrying one origin field (spliced at __ORIGIN__).
    private static string SessionModel(string originFieldJson) => """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Session", "children": [
        { "source.rdb": { "@table": "sessions" } },
        { "field.long": { "name": "id" } },
        { "relationship.association": { "name": "turns", "@objectRef": "Turn", "@cardinality": "many" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Turn", "children": [
        { "source.rdb": { "@table": "turns" } },
        { "field.long": { "name": "id" } },
        { "field.boolean": { "name": "success" } },
        { "field.string": { "name": "label" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "SessionSummary", "children": [
        { "source.rdb": { "@kind": "view", "@view": "v_session" } },
        { "field.long": { "name": "id", "extends": "Session.id" } },
        __ORIGIN__,
        { "identity.primary": { "name": "id", "extends": "Session.id" } }
      ]}}
    ]}}
    """.Replace("__ORIGIN__", originFieldJson, System.StringComparison.Ordinal);

    // A computed field references the base entity's OWN fields (no @via).
    private static string ComputedModel(string fieldJson) => """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "LlmCall", "children": [
        { "source.rdb": { "@table": "llm_calls" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "payloadJson" } },
        { "field.long": { "name": "durationMs" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "LlmCallSummary", "children": [
        { "source.rdb": { "@kind": "view", "@view": "v_llm" } },
        { "field.long": { "name": "id", "extends": "LlmCall.id" } },
        __FIELD__,
        { "identity.primary": { "name": "id", "extends": "LlmCall.id" } }
      ]}}
    ]}}
    """.Replace("__FIELD__", fieldJson, System.StringComparison.Ordinal);

    // -----------------------------------------------------------------------
    // origin.aggregate @agg any|all
    // -----------------------------------------------------------------------

    [Fact]
    public void Any_boolean_field_with_filter_and_via_no_of_is_clean()
    {
        var r = LoadInline(SessionModel("""
        { "field.boolean": { "name": "hasError", "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } }
        ]}}
        """));
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void All_vacuous_truth_quantifier_is_clean()
    {
        var r = LoadInline(SessionModel("""
        { "field.boolean": { "name": "allOk", "children": [
          { "origin.aggregate": { "@agg": "all", "@via": "Session.turns", "@filter": { "success": true } } }
        ]}}
        """));
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void Any_without_filter_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.boolean": { "name": "hasError", "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns" } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "@filter"));
    }

    [Fact]
    public void Any_with_of_is_invalid_origin_of_forbidden()
    {
        var r = LoadInline(SessionModel("""
        { "field.boolean": { "name": "hasError", "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false }, "@of": "Turn.success" } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "@of"));
    }

    [Fact]
    public void Any_on_non_boolean_field_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "hasError", "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "boolean"));
    }

    [Fact]
    public void Any_on_array_field_is_invalid_origin_inverse_rule()
    {
        var r = LoadInline(SessionModel("""
        { "field.boolean": { "name": "hasError", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { "success": false } } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "isArray"));
    }

    // -----------------------------------------------------------------------
    // origin.aggregate @agg collect
    // -----------------------------------------------------------------------

    [Fact]
    public void Collect_array_field_with_of_and_via_is_clean()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "labels", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": true } }
        ]}}
        """));
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void Collect_on_non_array_field_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "labels", "children": [
          { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns" } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "isArray"));
    }

    [Fact]
    public void Collect_element_type_must_match_of_subtype()
    {
        var r = LoadInline(SessionModel("""
        { "field.long": { "name": "labels", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns" } }
        ]}}
        """));
        Assert.True(HasErrorAny(r, ErrorCode.ERR_INVALID_ORIGIN, "type", "match"));
    }

    [Fact]
    public void Distinct_on_non_collect_aggregate_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.long": { "name": "turnCount", "children": [
          { "origin.aggregate": { "@agg": "count", "@of": "Turn.id", "@via": "Session.turns", "@distinct": true } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "distinct"));
    }

    [Fact]
    public void OrderBy_with_distinct_on_collect_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "labels", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": true, "@orderBy": ["label:asc"] } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "orderBy"));
    }

    [Fact]
    public void Non_collect_aggregate_on_array_field_is_invalid_origin_inverse_rule()
    {
        var r = LoadInline(SessionModel("""
        { "field.long": { "name": "turnCount", "isArray": true, "children": [
          { "origin.aggregate": { "@agg": "count", "@of": "Turn.id", "@via": "Session.turns" } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "isArray"));
    }

    // -----------------------------------------------------------------------
    // origin.computed
    // -----------------------------------------------------------------------

    [Fact]
    public void Computed_isNotNull_over_base_field_boolean_is_clean()
    {
        var r = LoadInline(ComputedModel("""
        { "field.boolean": { "name": "hasPayload", "children": [
          { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "payloadJson" } } } }
        ]}}
        """));
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void Computed_inferred_boolean_vs_declared_string_is_type_mismatch()
    {
        var r = LoadInline(ComputedModel("""
        { "field.string": { "name": "hasPayload", "children": [
          { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "payloadJson" } } } }
        ]}}
        """));
        Assert.Contains(r.Errors, e => e.Code == ErrorCode.ERR_COMPUTED_TYPE_MISMATCH);
    }

    [Fact]
    public void Computed_field_ref_to_nonexistent_base_field_is_error()
    {
        var r = LoadInline(ComputedModel("""
        { "field.boolean": { "name": "hasPayload", "children": [
          { "origin.computed": { "@expr": { "op": "isNotNull", "arg": { "field": "nope" } } } }
        ]}}
        """));
        Assert.Contains(r.Errors, e => e.Message.Contains("nope", System.StringComparison.Ordinal)
            && (e.Code == ErrorCode.ERR_INVALID_ORIGIN || e.Code == ErrorCode.ERR_UNKNOWN_EXPR_NODE));
    }

    [Fact]
    public void Computed_unknown_expression_op_is_unknown_expr_node()
    {
        var r = LoadInline(ComputedModel("""
        { "field.boolean": { "name": "hasPayload", "children": [
          { "origin.computed": { "@expr": { "op": "regexp", "arg": { "field": "payloadJson" } } } }
        ]}}
        """));
        Assert.Contains(r.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_EXPR_NODE);
    }

    // -----------------------------------------------------------------------
    // origin.first
    // -----------------------------------------------------------------------

    [Fact]
    public void First_with_of_via_orderBy_filter_non_required_is_clean()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "latestLabel", "children": [
          { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"], "@filter": { "success": true } } }
        ]}}
        """));
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void First_on_required_field_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "latestLabel", "@required": true, "children": [
          { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } }
        ]}}
        """));
        Assert.True(HasError(r, ErrorCode.ERR_INVALID_ORIGIN, "required"));
    }

    [Fact]
    public void First_of_type_preservation_mismatch_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.long": { "name": "latestLabel", "children": [
          { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } }
        ]}}
        """));
        Assert.True(HasErrorAny(r, ErrorCode.ERR_INVALID_ORIGIN, "type", "match"));
    }

    [Fact]
    public void First_orderBy_key_not_resolving_on_related_entity_is_invalid_origin()
    {
        var r = LoadInline(SessionModel("""
        { "field.string": { "name": "latestLabel", "children": [
          { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["nope:desc"] } }
        ]}}
        """));
        Assert.True(HasErrorAny(r, ErrorCode.ERR_INVALID_ORIGIN, "nope", "orderBy"));
    }
}
