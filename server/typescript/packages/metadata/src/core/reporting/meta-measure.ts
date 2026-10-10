// MetaMeasure — concrete node class for type=measure nodes (FR-044).
//
// Extends MetaData directly. Accessors are RESOLVING (ADR-0039).

import { MetaData } from "../../shared/meta-data.js";
import {
  MEASURE_AGGS,
  MEASURE_SUBTYPE_RATIO,
  REPORTING_ATTR_AGG,
  REPORTING_ATTR_DEFAULT,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_DISTINCT,
  REPORTING_ATTR_FILTER,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_SEGMENT,
  type MeasureAgg,
} from "./reporting-constants.js";

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export class MetaMeasure extends MetaData {
  /** True for `measure.ratio`; false for `measure.aggregate`. */
  isRatio(): boolean {
    return this.subType === MEASURE_SUBTYPE_RATIO;
  }

  /** The aggregate function (`measure.aggregate` only). */
  agg(): MeasureAgg | undefined {
    const v = this.attr(REPORTING_ATTR_AGG);
    return (MEASURE_AGGS as readonly unknown[]).includes(v) ? (v as MeasureAgg) : undefined;
  }

  /** True when `@distinct` is set (legal only with `@agg: count`). */
  distinct(): boolean {
    return this.attr(REPORTING_ATTR_DISTINCT) === true;
  }

  /** The `Entity.field` references in `@of`: a bare string is one column, a list is the tuple form. */
  ofColumns(): string[] {
    const v = this.attr(REPORTING_ATTR_OF);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return typeof v === "string" ? [v] : [];
  }

  /** Name of a segment declared on the same entity; combines with `@filter` by AND. */
  segmentName(): string | undefined {
    return optionalString(this.attr(REPORTING_ATTR_SEGMENT));
  }

  /** The canonical row-scope filter, when one is declared. */
  filter(): Record<string, unknown> | undefined {
    const v = this.attr(REPORTING_ATTR_FILTER);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }

  /** `@default`: the integer this measure reads when it would otherwise be null (rule M7/M8
   *  decide where it is legal). ADR-0039: resolving, so an inherited measure keeps it. */
  defaultValue(): number | undefined {
    const v = this.attr(REPORTING_ATTR_DEFAULT);
    return typeof v === "number" && Number.isInteger(v) ? v : undefined;
  }

  /** Name of the `measure.aggregate` sibling used as the numerator (`measure.ratio` only). */
  numerator(): string | undefined {
    return optionalString(this.attr(REPORTING_ATTR_NUMERATOR));
  }

  /** Name of the `measure.aggregate` sibling used as the denominator (`measure.ratio` only). */
  denominator(): string | undefined {
    return optionalString(this.attr(REPORTING_ATTR_DENOMINATOR));
  }
}
