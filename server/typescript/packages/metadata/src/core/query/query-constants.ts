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
export const FILTER_OP_EQ = "eq";
export const FILTER_OP_NE = "ne";
export const FILTER_OP_IN = "in";
export const FILTER_OP_IS_NULL = "isNull";

// Composition-key constants — used by desugarFilterObject in meta-attr-filter.ts.
export const FILTER_COMPOSE_OR = "or";
export const FILTER_COMPOSE_AND = "and";

export const FILTER_OPS = [
  FILTER_OP_EQ, FILTER_OP_NE, "gt", "gte", "lt", "lte", FILTER_OP_IN, "like", FILTER_OP_IS_NULL,
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const OPS_BY_SUBTYPE: Readonly<Record<string, readonly FilterOp[]>> = {
  string:    ["eq", "ne", "in", "like", "isNull"],
  int:       ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  short:     ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  byte:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  long:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  double:    ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  float:     ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  decimal:   ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  boolean:   ["eq", "isNull"],
  date:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  time:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  timestamp: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
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
