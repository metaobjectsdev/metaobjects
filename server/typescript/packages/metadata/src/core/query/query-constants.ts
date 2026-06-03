import { FIELD_SUBTYPE_UUID } from "../field/field-constants.js";

// Query concern constants — filter operators, sort order values.
//
// NOTE: `query` is NOT a metamodel node type — it has no subtype, schema, or
// accessor. It's a cross-cutting vocabulary grouping for query/filter helpers
// consumed by both core/field (@filterable/@sortable) and presentation/layout
// (dataGrid @defaultSortOrder). Co-located here as the most foundational shared
// home; intentional, not an incomplete migration.

// ---------------------------------------------------------------------------
// Filter operators (Project D) — shared source of truth across server +
// codegen. Each subtype declares which operators are legal for fields of that
// type. Server allowlist generation + TS type generation + codegen-time grid
// validation all import from here.
// ---------------------------------------------------------------------------

// Individual operator constants — used by the parse-time desugar in
// parser-core.ts. Must stay in sync with FILTER_OPS below.
export const FILTER_OP_EQ      = "eq";
export const FILTER_OP_NE      = "ne";
export const FILTER_OP_GT      = "gt";
export const FILTER_OP_GTE     = "gte";
export const FILTER_OP_LT      = "lt";
export const FILTER_OP_LTE     = "lte";
export const FILTER_OP_IN      = "in";
export const FILTER_OP_LIKE    = "like";
export const FILTER_OP_IS_NULL = "isNull";

// Composition-key constants — used by desugarFilterObject in meta-attr-filter.ts.
export const FILTER_COMPOSE_OR = "or";
export const FILTER_COMPOSE_AND = "and";

export const FILTER_OPS = [
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
  FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL,
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const OPS_BY_SUBTYPE: Readonly<Record<string, readonly FilterOp[]>> = {
  string:    [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL],
  int:       [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  long:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  double:    [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  float:     [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  decimal:   [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  boolean:   [FILTER_OP_EQ, FILTER_OP_IS_NULL],
  date:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  time:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  timestamp: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  // uuid: identity-comparison ops only — no `like` (not free-text) and no
  // ordering (`gt`/`lt` are meaningless on a UUID).
  [FIELD_SUBTYPE_UUID]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL],
} as const;

export function opsForSubType(subType: string): readonly FilterOp[] {
  return OPS_BY_SUBTYPE[subType] ?? [];
}

// ---------------------------------------------------------------------------
// Sort order values (used by @sortableDefaultOrder on fields and
// @defaultSortOrder on dataGrid layouts)
// ---------------------------------------------------------------------------

export const SORT_ORDER_ASC  = "asc";
export const SORT_ORDER_DESC = "desc";

export const SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC] as const;
export type SortOrderValue = (typeof SORT_ORDER_VALUES)[number];
