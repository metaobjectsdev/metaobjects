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
import type { MetaRoot } from "../../shared/meta-root.js";
import { TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT } from "../../shared/base-types.js";
import { SOURCE_KIND_VIEW } from "../../persistence/source/source-constants.js";
import type { MetaObject } from "../object/meta-object.js";
import { OBJECT_REPORT_ATTR_FILTER, OBJECT_REPORT_ATTR_SEGMENT } from "../object/object-constants.js";
import {
  DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_RATIO,
  REPORTING_ATTR_AGG,
  REPORTING_ATTR_DEFAULT,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_DISTINCT,
  REPORTING_ATTR_FILTER,
  REPORTING_ATTR_GRAINS,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_SEGMENT,
  REPORTING_ATTR_VIA,
} from "./reporting-constants.js";
import { reportSpine } from "./report-accessors.js";
import { reportReadSource } from "./report-read-model.js";
import { reportSpineEntity, type ReportField, type ReportShape } from "./report-shape.js";

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

/**
 * "; `0` when there is nothing to aggregate": the clause a measure's `@default` adds (R9), or
 * "" when it declares none. The declared integer is printed as written.
 */
function defaultClause(measure: MetaData): string {
  const declared = measure.attr(REPORTING_ATTR_DEFAULT);
  return typeof declared === "number" ? `; ${tick(String(declared))} when there is nothing to aggregate` : "";
}

/**
 * A measure in words: the aggregate and its row scope, or the ratio and its null rule. A
 * `@default` ends either with the value it reads when there is nothing to aggregate; a
 * defaulted ratio is never null, so its null rule gives way to that clause.
 */
export function describeMeasure(measure: MetaData): string {
  const fallback = defaultClause(measure);
  if (measure.subType === MEASURE_SUBTYPE_RATIO) {
    const numerator = measure.attr(REPORTING_ATTR_NUMERATOR);
    const denominator = measure.attr(REPORTING_ATTR_DENOMINATOR);
    const quotient = `${tick(String(numerator ?? ""))} / ${tick(String(denominator ?? ""))}`;
    return fallback !== "" ? `${quotient}${fallback}` : `${quotient}, null when the denominator is 0`;
  }
  const columns = stringList(measure.attr(REPORTING_ATTR_OF)).map(tick);
  const of = columns.length === 1 ? columns[0]! : `(${columns.join(", ")})`;
  const distinct = measure.attr(REPORTING_ATTR_DISTINCT) === true ? "distinct " : "";
  const scope = describeRowScope(measure.attr(REPORTING_ATTR_SEGMENT), measure.attr(REPORTING_ATTR_FILTER));
  return `${String(measure.attr(REPORTING_ATTR_AGG) ?? "")} of ${distinct}${of}${scope !== undefined ? ` where ${scope}` : ""}${fallback}`;
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

/**
 * Where a report with `@spine` takes its rows (R8): "one row per distinct dimension tuple
 * among the rows of `Program`, reached by `Purchase.program`, including those no `Purchase`
 * refers to". Undefined for a report without `@spine`, whose rows are the groups of its
 * `@from` rows and need no sentence. The spine is printed as declared.
 */
export function describeReportRows(shape: ReportShape, root: MetaRoot): string | undefined {
  const spine = reportSpine(shape.report);
  const entity = reportSpineEntity(shape.report, shape.from, root);
  if (spine === undefined || entity === undefined) return undefined;
  return (
    `one row per distinct dimension tuple among the rows of ${tick(entity.name)}, reached by ${tick(spine)}, ` +
    `including those no ${tick(shape.from.name)} refers to`
  );
}

/**
 * A report's row scope ({@link describeRowScope} over its `@segment` and `@filter`), or
 * undefined when it declares neither. Under `@spine` the scope chooses which rows of `@from`
 * are aggregated and never removes a row of the report, so it reads "aggregating only
 * segment `paid`".
 */
export function describeReportRowScope(report: MetaObject): string | undefined {
  // ADR-0039: resolving.
  const scope = describeRowScope(report.attr(OBJECT_REPORT_ATTR_SEGMENT), report.attr(OBJECT_REPORT_ATTR_FILTER));
  if (scope === undefined) return undefined;
  return reportSpine(report) !== undefined ? `aggregating only ${scope}` : scope;
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
  REPORTING_ATTR_DEFAULT,
] as const;
const RATIO_ATTRS = [REPORTING_ATTR_NUMERATOR, REPORTING_ATTR_DENOMINATOR, REPORTING_ATTR_DEFAULT] as const;
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
