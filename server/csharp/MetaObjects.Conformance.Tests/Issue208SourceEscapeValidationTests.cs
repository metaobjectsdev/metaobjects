// #208 — DDL-ownership escape valves loader validation (design doc §5, R1–R6).
//
// Mirrors typescript/packages/metadata/test/validate-source-escapes.test.ts.
// One test per rule: R1–R5 are hard errors, R6 is a WARN (not an error), plus a
// positive case (a valid @sql view projection with no origins) that must load clean.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Issue208SourceEscapeValidationTests
{
    private static LoadResult LoadInline(string json) =>
        MetaDataLoader.FromString(json, MetaDataFormat.Json);

    [Fact]
    public void R1_sql_and_unmanaged_on_one_source_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "H", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "SELECT 1", "@unmanaged": true } },
            { "field.long": { "name": "id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_SQL_BODY_WITH_UNMANAGED);
    }

    [Fact]
    public void R2_sql_on_writable_kind_table_default_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "H", "children": [
            { "source.rdb": { "@table": "t", "@sql": "SELECT 1" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_SQL_BODY_ON_WRITABLE_KIND);
    }

    [Fact]
    public void R3_sql_present_but_empty_string_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "H", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "" } },
            { "field.long": { "name": "id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void R3b_sql_present_but_whitespace_only_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "H", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "   " } },
            { "field.long": { "name": "id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void R4_origin_under_sql_host_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Base", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ] } },
          { "object.projection": { "name": "H", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_h", "@sql": "SELECT id, title FROM base" } },
            { "field.long": { "name": "id", "extends": "acme::Base.id" } },
            { "field.string": { "name": "displayTitle", "children": [
              { "origin.passthrough": { "@from": "acme::Base.title" } }
            ] } },
            { "identity.primary": { "name": "id", "extends": "acme::Base.id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY);
    }

    [Fact]
    public void R5_filter_207_plus_sql_on_a_projection_is_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.uuid": { "name": "id" } },
            { "field.string": { "name": "status" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } },
          { "object.projection": { "name": "ActiveOrders", "@filter": { "status": { "ne": "archived" } }, "children": [
            { "source.rdb": {
                "@kind": "view",
                "@view": "v_active_orders",
                "@sql": "SELECT * FROM orders WHERE status <> 'archived'"
            } },
            { "field.uuid": { "name": "id", "extends": "acme::Order.id" } },
            { "field.string": { "name": "status", "extends": "acme::Order.status" } },
            { "identity.primary": { "name": "id", "extends": "acme::Order.id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY);
    }

    [Fact]
    public void R6_origin_under_unmanaged_host_is_a_warning_not_an_error()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Base", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ] } },
          { "object.projection": { "name": "H", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_h", "@unmanaged": true } },
            { "field.long": { "name": "id", "extends": "acme::Base.id" } },
            { "field.string": { "name": "displayTitle", "children": [
              { "origin.passthrough": { "@from": "acme::Base.title" } }
            ] } },
            { "identity.primary": { "name": "id", "extends": "acme::Base.id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        Assert.NotNull(result.EnvelopeWarnings);
        Assert.Contains(result.EnvelopeWarnings!, w => w.Code == WarningCodes.WARN_ORIGIN_UNDER_UNMANAGED);
    }

    [Fact]
    public void Positive_valid_sql_view_projection_with_no_origins_loads_clean()
    {
        var doc = """
        { "metadata.root": { "package": "demo", "children": [
          { "object.projection": { "name": "ProgramSummaryEscaped", "children": [
            { "source.rdb": {
                "@kind": "view",
                "@view": "v_program_summary_escaped",
                "@sql": "SELECT id, count(*) AS n FROM program GROUP BY id"
            } },
            { "field.long": { "name": "id" } }
          ] } },
          { "object.entity": { "name": "LegacyAccount", "children": [
            { "source.rdb": { "@table": "legacy_account", "@unmanaged": true } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        Assert.True(result.EnvelopeWarnings is null || result.EnvelopeWarnings.Count == 0);
    }
}
