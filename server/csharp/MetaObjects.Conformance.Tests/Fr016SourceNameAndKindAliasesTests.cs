// FR-016 / ADR-0018 — source.rdb per-kind physical-name aliases.
//
// Mirrors typescript/packages/metadata/test/fr016-source-name-and-kind-aliases.test.ts.
// Covers constants exposure, schema registration, four-step PhysicalName resolution,
// loader validation (multi/mismatch/empty), legacy WARN_LEGACY_PHYSICAL_NAME_ALIAS,
// and the canonical-serializer per-kind rewrite.

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Persistence.Source;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr016SourceNameAndKindAliasesTests
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static LoadResult LoadInline(string json) =>
        MetaDataLoader.FromString(json, MetaDataFormat.Json);

    private static MetaSource FirstSource(string json)
    {
        var result = LoadInline(json);
        Assert.Empty(result.Errors);
        var entity = result.Root.OwnChildren().First(c => c.Type == "object");
        return (MetaSource)entity.OwnChildren().First(c => c.Type == "source");
    }

    private static readonly string[] ReadOnlyKinds = { "view", "materializedView", "storedProc", "tableFunction" };

    // FR-024 B4b: a read-only-kind primary source can't sit on an object.entity —
    // a derived read model is an object.projection. The subtype is chosen from the
    // source body's @kind so these FR-016 physical-name-alias fixtures stay loadable;
    // a projection's identity must extend an entity identity, so the projection
    // variant omits identity (projection identity is optional).
    private static string OneEntityDoc(string entityName, string sourceBody)
    {
        bool readOnly = ReadOnlyKinds.Any(k =>
            sourceBody.Contains("\"@kind\": \"" + k + "\"") || sourceBody.Contains("\"@kind\":\"" + k + "\""));
        string subtype = readOnly ? "object.projection" : "object.entity";
        string tail = readOnly
            ? "    { \"field.long\": { \"name\": \"id\" } }"
            : "    { \"field.long\": { \"name\": \"id\" } }," +
              "    { \"identity.primary\": { \"@fields\": \"id\" } }";
        return "{ \"metadata.root\": { \"package\": \"demo\", \"children\": [" +
            "  { \"" + subtype + "\": { \"name\": \"" + entityName + "\", \"children\": [" +
            "    { \"source.rdb\": " + sourceBody + " }," +
            tail +
            "  ]}}" +
            "]}}";
    }

    // -------------------------------------------------------------------------
    // 1. Constants + map exposure
    // -------------------------------------------------------------------------

    [Fact]
    public void Per_kind_alias_constants_are_distinct()
    {
        var names = new[]
        {
            SourceConstants.SOURCE_ATTR_TABLE,
            SourceConstants.SOURCE_ATTR_VIEW,
            SourceConstants.SOURCE_ATTR_MATERIALIZED_VIEW,
            SourceConstants.SOURCE_ATTR_PROC,
            SourceConstants.SOURCE_ATTR_FUNCTION,
        };
        Assert.Equal(5, names.Distinct().Count());
        Assert.Equal("table", SourceConstants.SOURCE_ATTR_TABLE);
        Assert.Equal("view", SourceConstants.SOURCE_ATTR_VIEW);
        Assert.Equal("materializedView", SourceConstants.SOURCE_ATTR_MATERIALIZED_VIEW);
        Assert.Equal("proc", SourceConstants.SOURCE_ATTR_PROC);
        Assert.Equal("function", SourceConstants.SOURCE_ATTR_FUNCTION);
    }

    [Fact]
    public void Physical_name_attr_by_kind_maps_every_kind()
    {
        Assert.Equal(SourceConstants.SOURCE_ATTR_TABLE,
            SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND[SourceConstants.SOURCE_KIND_TABLE]);
        Assert.Equal(SourceConstants.SOURCE_ATTR_VIEW,
            SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND[SourceConstants.SOURCE_KIND_VIEW]);
        Assert.Equal(SourceConstants.SOURCE_ATTR_MATERIALIZED_VIEW,
            SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND[SourceConstants.SOURCE_KIND_MATERIALIZED_VIEW]);
        Assert.Equal(SourceConstants.SOURCE_ATTR_PROC,
            SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND[SourceConstants.SOURCE_KIND_STORED_PROC]);
        Assert.Equal(SourceConstants.SOURCE_ATTR_FUNCTION,
            SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND[SourceConstants.SOURCE_KIND_TABLE_FUNCTION]);
    }

    // -------------------------------------------------------------------------
    // 2. Schema registration on source.rdb
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("table")]
    [InlineData("view")]
    [InlineData("materializedView")]
    [InlineData("proc")]
    [InlineData("function")]
    public void Source_rdb_schema_declares_per_kind_alias(string aliasName)
    {
        var names = SourceSchema.RdbSourceAttrs.Select(s => s.Name).ToList();
        Assert.Contains(aliasName, names);
    }

    // -------------------------------------------------------------------------
    // 3. PhysicalName four-step rule
    // -------------------------------------------------------------------------

    [Fact]
    public void Step1_kind_matching_alias_wins_for_each_kind()
    {
        var cases = new (string kind, string attr, string value)[]
        {
            ("table", "table", "tbl_demo"),
            ("view", "view", "v_demo"),
            ("materializedView", "materializedView", "mv_demo"),
            ("storedProc", "proc", "fn_demo"),
            ("tableFunction", "function", "tf_demo"),
        };
        foreach (var (kind, attr, value) in cases)
        {
            var body = "{ \"@kind\": \"" + kind + "\", \"@" + attr + "\": \"" + value + "\" }";
            var doc = OneEntityDoc("Demo", body);
            var src = FirstSource(doc);
            Assert.Equal(value, src.PhysicalName);
        }
    }

    [Fact]
    public void Step2_legacy_table_for_non_table_kind()
    {
        // @table with @kind: "storedProc" → legacy fallback used (with warning).
        var doc = OneEntityDoc("Demo", """{ "@kind": "storedProc", "@table": "fn_legacy" }""");
        var src = FirstSource(doc);
        Assert.Equal("fn_legacy", src.PhysicalName);
    }

    [Fact]
    public void Step3_bare_source_name_snake_case()
    {
        var doc = OneEntityDoc("Customer", """{ "name": "Customers" }""");
        var src = FirstSource(doc);
        Assert.Equal("customers", src.PhysicalName);
    }

    [Fact]
    public void Step4_owning_entity_pluralize_snake_case()
    {
        var doc = OneEntityDoc("Customer", "{}");
        var src = FirstSource(doc);
        Assert.Equal("customers", src.PhysicalName);
    }

    // -------------------------------------------------------------------------
    // 4. Validation — ERR_PHYSICAL_NAME_MULTIPLE
    // -------------------------------------------------------------------------

    [Fact]
    public void Multiple_kind_aware_aliases_is_an_error()
    {
        var doc = OneEntityDoc("Demo", """{ "@table": "t_demo", "@view": "v_demo" }""");
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE);
    }

    // -------------------------------------------------------------------------
    // 5. Validation — ERR_PHYSICAL_NAME_KIND_MISMATCH
    // -------------------------------------------------------------------------

    [Fact]
    public void Non_table_alias_with_wrong_kind_is_an_error()
    {
        // @proc with @kind: "view" → ERR_PHYSICAL_NAME_KIND_MISMATCH.
        var doc = OneEntityDoc("Demo", """{ "@kind": "view", "@proc": "fn_demo" }""");
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH);
    }

    // -------------------------------------------------------------------------
    // 6. Validation — WARN_LEGACY_PHYSICAL_NAME_ALIAS (legacy @table + non-table kind)
    // -------------------------------------------------------------------------

    [Fact]
    public void Legacy_table_for_non_table_kind_emits_warning()
    {
        var doc = OneEntityDoc("Demo", """{ "@kind": "view", "@table": "v_demo" }""");
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        Assert.NotNull(result.EnvelopeWarnings);
        Assert.Contains(result.EnvelopeWarnings!,
            w => w.Code == WarningCodes.WARN_LEGACY_PHYSICAL_NAME_ALIAS);
    }

    // -------------------------------------------------------------------------
    // 7. Validation — ERR_BAD_ATTR_VALUE (empty-string alias)
    // -------------------------------------------------------------------------

    [Fact]
    public void Empty_string_alias_is_an_error()
    {
        var doc = OneEntityDoc("Demo", """{ "@kind": "view", "@view": "" }""");
        var result = LoadInline(doc);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    // -------------------------------------------------------------------------
    // 8. Canonical serializer — per-kind rewrite
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("view", "view", "v_x")]
    [InlineData("materializedView", "materializedView", "mv_x")]
    [InlineData("storedProc", "proc", "fn_x")]
    [InlineData("tableFunction", "function", "tf_x")]
    public void Canonical_serializer_rewrites_legacy_table_to_kind_matching_alias(
        string kind, string canonicalAttr, string value)
    {
        var body = "{ \"@kind\": \"" + kind + "\", \"@table\": \"" + value + "\" }";
        var doc = OneEntityDoc("Demo", body);
        var result = LoadInline(doc);
        // Legacy spelling: warning, no errors.
        Assert.Empty(result.Errors);
        var canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.Contains($"\"@{canonicalAttr}\": \"{value}\"", canonical);
        Assert.DoesNotContain($"\"@table\": \"{value}\"", canonical);
    }

    [Fact]
    public void Canonical_serializer_is_no_op_for_table_kind()
    {
        var doc = OneEntityDoc("Demo", """{ "@kind": "table", "@table": "t_demo" }""");
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        var canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.Contains("\"@table\": \"t_demo\"", canonical);
    }

    [Fact]
    public void Canonical_serializer_preserves_already_canonical_view_alias()
    {
        var doc = OneEntityDoc("Demo", """{ "@kind": "view", "@view": "v_demo" }""");
        var result = LoadInline(doc);
        Assert.Empty(result.Errors);
        var canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.Contains("\"@view\": \"v_demo\"", canonical);
        Assert.DoesNotContain("\"@table\":", canonical);
    }
}
