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

export const ORIGIN_SUBTYPES = [
  SUBTYPE_BASE,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COLLECTION,
] as const;
export type OriginSubType = (typeof ORIGIN_SUBTYPES)[number];

// passthrough attrs
export const ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
export const ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";
// @convert (boolean): acknowledges a deliberate type change vs the @from source
// (#185). Suppresses ERR_PASSTHROUGH_TYPE_MISMATCH. Acknowledgement only — it
// does NOT generate a cast; real type-converting projections are origin.expression (#159).
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
// FILTER (WHERE …) / SQLite CASE WHEN.
export const ORIGIN_AGGREGATE_ATTR_FILTER = "filter";

// aggregate function vocabulary
export const AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];
