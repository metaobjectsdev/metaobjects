// Reporting concern constants (FR-044) — type names, subtypes, attr keys and
// the closed sets the registry enforces through `allowedValues`.
//
// `dimension`, `measure` and `segment` are children of `object.entity` only
// (never root-level), and `object.report` (see object-constants.ts) references
// them by name. The type-name constants live in shared/base-types.ts beside
// every other base type and are re-exported here so a reporting consumer has
// one import site.

import { TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT } from "../../shared/base-types.js";

export { TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT };

// ---------------------------------------------------------------------------
// Subtypes
// ---------------------------------------------------------------------------

/** Groups by a column value as-is (no grain, no truncation). */
export const DIMENSION_SUBTYPE_ATTRIBUTE = "attribute";
/** Groups by a date/timestamp column truncated to a grain. */
export const DIMENSION_SUBTYPE_TIME = "time";
export const DIMENSION_SUBTYPES = [DIMENSION_SUBTYPE_ATTRIBUTE, DIMENSION_SUBTYPE_TIME] as const;
export type DimensionSubType = (typeof DIMENSION_SUBTYPES)[number];

/** One aggregate over the declaring entity's own rows. */
export const MEASURE_SUBTYPE_AGGREGATE = "aggregate";
/** A quotient of two `measure.aggregate` siblings, `numerator / NULLIF(denominator, 0)`.
 *  `measure.derived` is deliberately NOT registered: it waits for FR-037 R5. */
export const MEASURE_SUBTYPE_RATIO = "ratio";
export const MEASURE_SUBTYPES = [MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO] as const;
export type MeasureSubType = (typeof MEASURE_SUBTYPES)[number];

/** A named, reusable row filter. The only concrete segment subtype: every `*.base`
 *  in the registry is an abstract anchor, so authors write `segment.filter`. */
export const SEGMENT_SUBTYPE_FILTER = "filter";
export const SEGMENT_SUBTYPES = [SEGMENT_SUBTYPE_FILTER] as const;
export type SegmentSubType = (typeof SEGMENT_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Attrs (on dimension / measure / segment nodes)
// ---------------------------------------------------------------------------

/** Dotted `Entity.field` reference(s) naming the grouped / aggregated column(s). */
export const REPORTING_ATTR_OF = "of";
/** Optional dotted to-one relationship path from the owning entity to the `@of` entity. */
export const REPORTING_ATTR_VIA = "via";
/** The grains a `dimension.time` supports. */
export const REPORTING_ATTR_GRAINS = "grains";
/** The aggregate function of a `measure.aggregate`. */
export const REPORTING_ATTR_AGG = "agg";
/** Count distinct values (legal only with `@agg: count`). */
export const REPORTING_ATTR_DISTINCT = "distinct";
/** Row scope (an attr.filter) on a `measure.aggregate` or `segment.filter`. */
export const REPORTING_ATTR_FILTER = "filter";
/** Name of a segment declared on the same entity. */
export const REPORTING_ATTR_SEGMENT = "segment";
/** `measure.ratio` operand names. */
export const REPORTING_ATTR_NUMERATOR = "numerator";
export const REPORTING_ATTR_DENOMINATOR = "denominator";

// ---------------------------------------------------------------------------
// Closed sets — mirrored by `allowedValues` in spec/metamodel/reporting.json.
// Order is part of the contract (it is the order the registry manifest records).
// ---------------------------------------------------------------------------

/** Weeks start on Monday (ISO-8601) in every lowering. */
export const TIME_GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];

export const MEASURE_AGGS = ["count", "sum", "avg", "min", "max"] as const;
export type MeasureAgg = (typeof MEASURE_AGGS)[number];

/** Separator in an `object.report` `@dimensions` item: `name` or `name:grain`. */
export const REPORT_DIMENSION_GRAIN_SEPARATOR = ":";

// ---------------------------------------------------------------------------
// Relative-date filter values (FR-044 R4)
// ---------------------------------------------------------------------------

/** The single key of a relative-date filter value: `{ now: "<ISO-8601 duration>" }`
 *  means "the current time plus that duration", evaluated when the view is queried.
 *  Legal only in the `@filter` of a `segment`, `measure.aggregate` or `object.report`. */
export const FILTER_RELATIVE_NOW = "now";

/** A signed ISO-8601 duration (`-P7D`, `P1Y2M`, `-PT12H`). The lookaheads refuse the
 *  degenerate `P` and `PT` forms (a designator with no component). */
export const ISO_DURATION_RE =
  /^[+-]?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
