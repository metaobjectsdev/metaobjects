import { FIELD_SUBTYPE_UUID, FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET, FIELD_ATTR_INT_VALUE_MAP } from "../field/field-constants.js";

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
  // enum: string-backed — same op band as string.
  [FIELD_SUBTYPE_ENUM]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL],
  int:       [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  long:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  double:    [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  float:     [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  decimal:   [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  // currency: integer minor units — an orderable number. Numeric ops, no `like`.
  [FIELD_SUBTYPE_CURRENCY]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  boolean:   [FILTER_OP_EQ, FILTER_OP_IS_NULL],
  date:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  time:      [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  timestamp: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  // uuid: identity-comparison ops only — no `like` (not free-text) and no
  // ordering (`gt`/`lt` are meaningless on a UUID).
  [FIELD_SUBTYPE_UUID]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL],
  // uri: a URI string — free-text-comparable. Same op band as string (prefix
  // matching with `like` is meaningful for URLs).
  [FIELD_SUBTYPE_URI]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL],
  // inet: an IP address — identity-comparison ops only (no `like`; ordering
  // gt/lt is not exposed). Same op band as uuid.
  [FIELD_SUBTYPE_INET]: [FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL],
} as const;

export function opsForSubType(subType: string): readonly FilterOp[] {
  return OPS_BY_SUBTYPE[subType] ?? [];
}

/** The int-backed-enum band: the enum band minus `like`. Hoisted so the narrowing
 *  is one named constant rather than a filter re-derived at every call. */
const OPS_ENUM_INT_BACKED: readonly FilterOp[] = [
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_IS_NULL,
];

/**
 * The structural shape `opsForField` needs. Declared here rather than importing
 * `MetaField`: `query-constants` is foundational and `core/field` imports it, so a
 * type import back the other way would close a cycle.
 */
export interface FilterOpBandField {
  readonly subType: string;
  attr(name: string): unknown;
}

/**
 * The filter-operator band for a FIELD — the entry point every consumer that has a
 * field in hand must use (loader validation, generated allowlists, generated client
 * filter types, the cross-port `field.filter-ops` capability).
 *
 * Identical to {@link opsForSubType} except for ONE case: an int-backed `field.enum`
 * (one declaring `@intValueMap`, design D5) persists as an INTEGER column, so `like`
 * — a substring match — is dropped. `eq`/`ne`/`in` survive because the member symbol
 * encodes to its integer before it reaches SQL; `like` has no such encoding, and an
 * unencoded `LIKE 'DRAFT'` against an integer column is a request-time type error.
 *
 * `opsForSubType` cannot express this: it only ever sees the subtype `"enum"`. It is
 * deliberately left unchanged for the one caller that genuinely has no field — the
 * expression grammar's declared operand type.
 *
 * ADR-0039: the `@intValueMap` read is RESOLVING. Post-#246 the map lives on a shared
 * root-level abstract declaration and consuming fields INHERIT it, so an own-only read
 * would see `undefined` on exactly the shape adopters are steered toward and wrongly
 * keep `like` in the band.
 */
export function opsForField(field: FilterOpBandField): readonly FilterOp[] {
  if (field.subType === FIELD_SUBTYPE_ENUM && isIntBacked(field)) return OPS_ENUM_INT_BACKED;
  return opsForSubType(field.subType);
}

function isIntBacked(field: FilterOpBandField): boolean {
  const raw = field.attr(FIELD_ATTR_INT_VALUE_MAP);
  return raw !== undefined && raw !== null && typeof raw === "object";
}

// ---------------------------------------------------------------------------
// Sort order values (used by @sortableDefaultOrder on fields and
// @defaultSortOrder on dataGrid layouts)
// ---------------------------------------------------------------------------

export const SORT_ORDER_ASC  = "asc";
export const SORT_ORDER_DESC = "desc";

export const SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC] as const;
export type SortOrderValue = (typeof SORT_ORDER_VALUES)[number];
