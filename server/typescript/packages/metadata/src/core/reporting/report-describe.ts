// The reporting vocabulary in words (FR-044): what a dimension groups by, what a measure
// computes, which rows a segment or report is scoped to, and why a report is not served.
//
// One home for the wording. `meta docs` prints these sentences on the markdown model pages
// (codegen-ts) and on the HTML site (docs-site); both read them from here, so the two
// surfaces cannot say different things about the same node.
//
// Every function returns PLAIN TEXT whose identifiers sit in single-backtick spans
// ("sum of `Invoice.amountCents` where segment `paid`"). A caller turns the spans into
// its own markup. Nothing here derives SQL: a description says what a column means, never
// how the view computes it.
//
// Browser-safe: no Node-only import.

import type { MetaData } from "../../shared/meta-data.js";
import { TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT } from "../../shared/base-types.js";
import { SOURCE_KIND_VIEW } from "../../persistence/source/source-constants.js";
import type { MetaObject } from "../object/meta-object.js";
import {
  DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_RATIO,
  REPORTING_ATTR_AGG,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_DISTINCT,
  REPORTING_ATTR_FILTER,
  REPORTING_ATTR_GRAINS,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_SEGMENT,
  REPORTING_ATTR_VIA,
} from "./reporting-constants.js";
import { reportReadSource } from "./report-read-model.js";
import type { ReportField } from "./report-shape.js";

/** Inline code. A backtick cannot sit inside a single-backtick span, so it is dropped. */
function tick(text: string): string {
  return `\`${text.replace(/`/g, "")}\``;
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** A row-scope filter as the loader holds it: compact JSON in declared order, in a code span. */
export function describeFilter(filter: unknown): string {
  return tick(JSON.stringify(filter ?? {}));
}

/**
 * "segment `paid` and filter `{…}`": the rows a measure or a report is scoped to, or
 * undefined when it declares neither. The two combine by AND, as the lowering combines them.
 */
export function describeRowScope(segment: unknown, filter: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof segment === "string" && segment !== "") parts.push(`segment ${tick(segment)}`);
  if (filter !== undefined && filter !== null) parts.push(`filter ${describeFilter(filter)}`);
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/** "`Program.title` via `Purchase.program`": the column a dimension groups by. */
function dimensionColumn(dim: MetaData): string {
  // ADR-0039: resolving reads, here and in every describer below, so a node that
  // `extends` another is described by its effective attributes.
  const of = dim.attr(REPORTING_ATTR_OF);
  const via = dim.attr(REPORTING_ATTR_VIA);
  const column = tick(typeof of === "string" ? of : "");
  return typeof via === "string" && via !== "" ? `${column} via ${tick(via)}` : column;
}

/** A dimension as its entity declares it: the column, and for a time dimension its grains. */
export function describeDimension(dim: MetaData): string {
  const column = dimensionColumn(dim);
  if (dim.subType !== DIMENSION_SUBTYPE_TIME) return column;
  return `${column}; grains: ${stringList(dim.attr(REPORTING_ATTR_GRAINS)).join(", ")}`;
}

/**
 * A dimension as ONE report column. A time dimension is truncated to the grain the report
 * picked; reports are UTC only (there is no time-zone vocabulary). After a `via` clause
 * the truncation is set off by a comma, so it reads as applying to the column and not to
 * the relationship path.
 */
export function describeDimensionColumn(dim: MetaData, grain?: string): string {
  const column = dimensionColumn(dim);
  if (grain === undefined || grain === "") return column;
  const joiner = column.includes(" via ") ? "," : "";
  return `${column}${joiner} truncated to ${grain}, UTC`;
}

/** A measure in words: the aggregate and its row scope, or the ratio and its null rule. */
export function describeMeasure(measure: MetaData): string {
  if (measure.subType === MEASURE_SUBTYPE_RATIO) {
    const numerator = measure.attr(REPORTING_ATTR_NUMERATOR);
    const denominator = measure.attr(REPORTING_ATTR_DENOMINATOR);
    return `${tick(String(numerator ?? ""))} / ${tick(String(denominator ?? ""))}, null when the denominator is 0`;
  }
  const columns = stringList(measure.attr(REPORTING_ATTR_OF)).map(tick);
  const of = columns.length === 1 ? columns[0]! : `(${columns.join(", ")})`;
  const distinct = measure.attr(REPORTING_ATTR_DISTINCT) === true ? "distinct " : "";
  const scope = describeRowScope(measure.attr(REPORTING_ATTR_SEGMENT), measure.attr(REPORTING_ATTR_FILTER));
  return `${String(measure.attr(REPORTING_ATTR_AGG) ?? "")} of ${distinct}${of}${scope !== undefined ? ` where ${scope}` : ""}`;
}

/** A segment in words: its filter. */
export function describeSegment(segment: MetaData): string {
  return describeFilter(segment.attr(REPORTING_ATTR_FILTER));
}

/** One derived report column's definition, from the dimension or measure it comes from. */
export function describeReportField(field: ReportField): string {
  if (field.dimension !== undefined) return describeDimensionColumn(field.dimension, field.grain);
  return field.measure !== undefined ? describeMeasure(field.measure) : "";
}

/** The neutral logical type of a derived column: its Table B subtype, `[]` for an array. */
export function reportFieldTypeName(field: ReportField): string {
  // ADR-0039: resolvedIsArray() is the resolving read of the native array flag.
  return field.typeSource?.resolvedIsArray() === true ? `${field.subType}[]` : field.subType;
}

/**
 * Why a report is not served, or undefined when it is (Plan 3 Table A: served means not
 * abstract, with a read source of `@kind: view`).
 */
export function reportNotServedReason(report: MetaObject): string | undefined {
  if (report.isAbstract === true) return "Not served: the report is abstract";
  const source = reportReadSource(report);
  if (source === undefined) return "Not served: declares no view source";
  if (source.effectiveKind !== SOURCE_KIND_VIEW) {
    return `Not served: its source is a ${source.effectiveKind}, not a view`;
  }
  return undefined;
}

const DIMENSION_ATTRS = [REPORTING_ATTR_OF, REPORTING_ATTR_VIA] as const;
const TIME_DIMENSION_ATTRS = [...DIMENSION_ATTRS, REPORTING_ATTR_GRAINS] as const;
const AGGREGATE_ATTRS = [
  REPORTING_ATTR_AGG, REPORTING_ATTR_OF, REPORTING_ATTR_DISTINCT, REPORTING_ATTR_SEGMENT, REPORTING_ATTR_FILTER,
] as const;
const RATIO_ATTRS = [REPORTING_ATTR_NUMERATOR, REPORTING_ATTR_DENOMINATOR] as const;
const SEGMENT_ATTRS = [REPORTING_ATTR_FILTER] as const;

/**
 * The attributes the describer for `node` reads, so a documentation coverage audit can
 * mark exactly those as rendered and no others. Kept beside the describers: a describer
 * that starts reading a new attribute adds it here. Empty for any other node.
 */
export function reportingDescribedAttrs(node: MetaData): readonly string[] {
  if (node.type === TYPE_DIMENSION) return node.subType === DIMENSION_SUBTYPE_TIME ? TIME_DIMENSION_ATTRS : DIMENSION_ATTRS;
  if (node.type === TYPE_MEASURE) return node.subType === MEASURE_SUBTYPE_RATIO ? RATIO_ATTRS : AGGREGATE_ATTRS;
  if (node.type === TYPE_SEGMENT) return SEGMENT_ATTRS;
  return [];
}
