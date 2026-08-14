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

    /// <summary>
    /// The int-backed-<c>enum</c> band: the <c>enum</c> band minus <c>like</c>. Hoisted
    /// so the narrowing is one named constant rather than an array filtered at every call.
    /// </summary>
    public static readonly string[] OPS_ENUM_INT_BACKED =
        [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL];

    /// <summary>
    /// The filter-operator band for a FIELD — the entry point every consumer that has a
    /// field in hand must use (loader validation, the codegen filter-allowlist generator,
    /// the cross-port <c>field.filter-ops</c> capability).
    /// <para>
    /// Identical to <see cref="OpsForSubType"/> except for ONE case: an int-backed
    /// <c>field.enum</c> (one declaring <c>@intValueMap</c>, design D5) persists as an
    /// INTEGER column, so <c>like</c> — a substring match — is dropped.
    /// <c>eq</c>/<c>ne</c>/<c>in</c> survive because the member symbol encodes to its
    /// integer before it reaches SQL; <c>like</c> has no such encoding, and an unencoded
    /// <c>LIKE 'DRAFT'</c> against an integer column is a request-time type error.
    /// </para>
    /// <para>
    /// <see cref="OpsForSubType"/> cannot express this — it only ever sees the subtype
    /// <c>"enum"</c> — and is deliberately left unchanged for the one caller that
    /// genuinely has no field: <c>ExpressionGrammar</c>'s declared operand type.
    /// </para>
    /// <para>
    /// ADR-0039: the <c>@intValueMap</c> read is RESOLVING (<c>Attr</c>, not
    /// <c>OwnAttr</c>). Post-#246 the map lives on a shared root-level abstract
    /// declaration and consuming fields INHERIT it, so an own-only read would see it
    /// absent on exactly the shape adopters are steered toward and wrongly keep
    /// <c>like</c>.
    /// </para>
    /// <para>
    /// Cross-port: <c>fixtures/conformance/filter-ops-matrix</c> pins <c>fEnum</c> vs
    /// <c>fEnumInt</c> in all five ports.
    /// </para>
    /// <para>
    /// Takes <c>MetaData</c> rather than <c>MetaField</c> so the loader's dataGrid pass —
    /// which iterates untyped children — can call it directly, mirroring the TS
    /// structural parameter.
    /// </para>
    /// </summary>
    public static string[] OpsForField(MetaObjects.Meta.MetaData field)
    {
        if (field is null) return [];
        if (field.SubType == MetaObjects.Core.Field.FieldConstants.FIELD_SUBTYPE_ENUM &&
            field.Attr(MetaObjects.Core.Field.FieldConstants.FIELD_ATTR_INT_VALUE_MAP) is not null)
        {
            return OPS_ENUM_INT_BACKED;
        }
        return OpsForSubType(field.SubType);
    }

    // -----------------------------------------------------------------------
    // Sort order values (used by @sortableDefaultOrder on fields and
    // @defaultSortOrder on dataGrid layouts)
    // -----------------------------------------------------------------------

    public const string SORT_ORDER_ASC  = "asc";
    public const string SORT_ORDER_DESC = "desc";

    public static readonly string[] SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC];
}
