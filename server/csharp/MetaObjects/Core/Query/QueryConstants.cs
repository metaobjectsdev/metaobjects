// Query concern constants — filter operators, sort order values, and the
// per-field-subtype operator allowlist.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/query/query-constants.ts.
//
// NOTE: `query` is NOT a metamodel node type — it has no subtype, schema, or
// accessor. It's a cross-cutting vocabulary grouping for query/filter helpers
// consumed by both core/field (@filterable/@sortable) and presentation/layout
// (dataGrid @defaultSortOrder). Co-located here as the most foundational shared
// home; intentional, not an incomplete migration.

namespace MetaObjects.Core.Query;

/// <summary>
/// Cross-cutting query vocabulary — the 9 filter operators + sort-order values +
/// the per-field-subtype operator allowlist. Cross-language identifiers per CLAUDE.md.
/// </summary>
public static class QueryConstants
{
    // -----------------------------------------------------------------------
    // Filter operators (Project D) — shared source of truth across server +
    // codegen. Each subtype declares which operators are legal for fields of
    // that type.
    // -----------------------------------------------------------------------

    public const string FILTER_OP_EQ      = "eq";
    public const string FILTER_OP_NE      = "ne";
    public const string FILTER_OP_GT      = "gt";
    public const string FILTER_OP_GTE     = "gte";
    public const string FILTER_OP_LT      = "lt";
    public const string FILTER_OP_LTE     = "lte";
    public const string FILTER_OP_IN      = "in";
    public const string FILTER_OP_LIKE    = "like";
    public const string FILTER_OP_IS_NULL = "isNull";

    // Composition-key constants — used by DesugarFilterObject in Parser.cs.
    public const string FILTER_COMPOSE_OR  = "or";
    public const string FILTER_COMPOSE_AND = "and";

    public static readonly string[] FILTER_OPS =
    [
        FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
        FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL,
    ];

    public static readonly Dictionary<string, string[]> OPS_BY_SUBTYPE = new Dictionary<string, string[]>
    {
        ["string"]    = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL],
        // enum: string-backed — same op band as string.
        ["enum"]      = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL],
        // uuid: identity-comparison only — no `like` (not a substring type), no ordering.
        ["uuid"]      = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["int"]       = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["long"]      = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["double"]    = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["float"]     = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["decimal"]   = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        // currency: integer minor units — an orderable number.
        ["currency"]  = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["boolean"]   = [FILTER_OP_EQ, FILTER_OP_IS_NULL],
        ["date"]      = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["time"]      = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
        ["timestamp"] = [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
    };

    /// <summary>
    /// Returns the allowed filter operators for a given field subtype.
    /// Returns an empty array when the subtype is not in <see cref="OPS_BY_SUBTYPE"/>,
    /// matching the TS <c>OPS_BY_SUBTYPE[subType] ?? []</c> behaviour.
    /// </summary>
    public static string[] OpsForSubType(string subType) =>
        OPS_BY_SUBTYPE.TryGetValue(subType, out string[]? ops) ? ops : [];

    // -----------------------------------------------------------------------
    // Sort order values (used by @sortableDefaultOrder on fields and
    // @defaultSortOrder on dataGrid layouts)
    // -----------------------------------------------------------------------

    public const string SORT_ORDER_ASC  = "asc";
    public const string SORT_ORDER_DESC = "desc";

    public static readonly string[] SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC];
}
