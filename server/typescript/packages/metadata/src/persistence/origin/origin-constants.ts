// Origin concern constants — subtypes and attr keys for the origin.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Origin type — field-level provenance (Project E).
//
// Origin is a child of `field`. Says "this field's value comes from there."
// passthrough: from <Entity.field> [via <relationship path>]
// aggregate:   <agg> of <Entity.field> via <relationship path>
//
// ---------------------------------------------------------------------------

export const ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
export const ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";
export const ORIGIN_SUBTYPE_COLLECTION  = "collection";
// #195 — computed: a row-level value from the base entity's own fields via a
// structured @expr tree (no related rows). first: the single related row picked
// by @orderBy along @via, projecting @of (argmax-then-project).
export const ORIGIN_SUBTYPE_COMPUTED    = "computed";
export const ORIGIN_SUBTYPE_FIRST       = "first";

export const ORIGIN_SUBTYPES = [
  SUBTYPE_BASE,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COLLECTION,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
] as const;
export type OriginSubType = (typeof ORIGIN_SUBTYPES)[number];

// passthrough attrs
export const ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
export const ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";
// @convert (boolean): acknowledges a deliberate type change vs the @from source
// (#185). Suppresses ERR_PASSTHROUGH_TYPE_MISMATCH. Acknowledgement only — it
// does NOT generate a cast; real type-converting projections are origin.computed (#195/#159).
export const ORIGIN_PASSTHROUGH_ATTR_CONVERT = "convert";

// collection attrs — a relationship-derived array of nested view-objects
// (FR-004 R4). @via is the dotted relationship path (optionally wildcard-
// prefixed, e.g. "*.User", for a package-spanning collection).
export const ORIGIN_COLLECTION_ATTR_VIA = "via";

// aggregate attrs
export const ORIGIN_AGGREGATE_ATTR_AGG = "agg";
export const ORIGIN_AGGREGATE_ATTR_OF  = "of";
export const ORIGIN_AGGREGATE_ATTR_VIA = "via";
// @filter (attr.filter object): an optional PORTABLE structured predicate scoping
// which related rows the aggregate spans (same shape as a preset filter). Codegen
// renders it per target — the projection view emitter turns it into SQL
// FILTER (WHERE …) / SQLite CASE WHEN. On @agg:any|all it is the QUANTIFIED
// predicate (required there); on origin.first it scopes the eligible rows.
export const ORIGIN_AGGREGATE_ATTR_FILTER = "filter";
// #195 — shared origin attrs. @distinct (collect-only) applies set semantics;
// @orderBy carries ordering keys ('field[:asc|desc]', nulls-last) used by
// @agg:collect (element order) and required by origin.first (row selection).
export const ORIGIN_ATTR_DISTINCT  = "distinct";
export const ORIGIN_ATTR_ORDER_BY  = "orderBy";

// computed attrs — @expr is the structured expression tree (attr.expression).
export const ORIGIN_COMPUTED_ATTR_EXPR = "expr";

// first attrs — reuse the same physical names as aggregate (@of/@via/@filter)
// plus the required @orderBy above.
export const ORIGIN_FIRST_ATTR_OF     = "of";
export const ORIGIN_FIRST_ATTR_VIA    = "via";
export const ORIGIN_FIRST_ATTR_FILTER = "filter";

// aggregate function vocabulary.
//
// AGGREGATE_FUNCTIONS is the NUMERIC/ORDINAL reduce set — each maps directly to a
// SQL aggregate over the @of column and to the codegen `aggregate` SelectColumn
// kind. The predicate quantifiers (any/all) and the array rollup (collect) are
// distinct reducing behaviors handled by their own view-synthesis column kinds,
// so they are NOT in this set; the full @agg vocabulary is ORIGIN_AGG_VALUES.
export const AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

// #195 — the predicate-quantifier + array-rollup @agg values.
export const AGG_ANY     = "any";
export const AGG_ALL     = "all";
export const AGG_COLLECT = "collect";

/** The full @agg attribute vocabulary (matches origin.json allowedValues). */
export const ORIGIN_AGG_VALUES = [
  ...AGGREGATE_FUNCTIONS,
  AGG_ANY,
  AGG_ALL,
  AGG_COLLECT,
] as const;
export type OriginAggValue = (typeof ORIGIN_AGG_VALUES)[number];
