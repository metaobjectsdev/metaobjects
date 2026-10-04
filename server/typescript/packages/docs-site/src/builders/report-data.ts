// FR-044 on the HTML site (Table G of the Plan 3 spec):
//
//   • an `object.report`'s page gets a "Report" section: its `@from` (linked), the view it
//     is read from or why it is not served, its row scope, and one row per derived column
//     from `reportShape`;
//   • the page of an entity that declares dimensions, measures or segments, or that a
//     report names as its `@from`, gets a "Reporting" section.
//
// The sentences are the ones the markdown model pages print (codegen-ts
// `generators/report-doc.ts`). This package does not depend on codegen-ts, so the wording
// is restated here; `test/reporting-site.test.ts` and codegen-ts's
// `test/reporting-docs.test.ts` assert the same sentences over the same model.

import type { MetaData, MetaObject, MetaRoot, ReportField } from "@metaobjectsdev/metadata";
import {
  DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_RATIO,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SEGMENT,
  OBJECT_SUBTYPE_REPORT,
  REPORTING_ATTR_AGG,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_DISTINCT,
  REPORTING_ATTR_FILTER,
  REPORTING_ATTR_GRAINS,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_SEGMENT,
  REPORTING_ATTR_VIA,
  SOURCE_KIND_VIEW,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_OBJECT,
  TYPE_SEGMENT,
  reportReadSource,
  reportShape,
} from "@metaobjectsdev/metadata";
import { type DocNode, type LinkGraph, fqnOf } from "../link-graph.js";
import type { CoverageTracker } from "../coverage.js";
import { esc } from "../badges.js";

/** The attrs of an `object.report` the Report section renders (so the generic
 *  attribute badges on the page skip them). */
export const REPORT_RENDERED_ATTRS: ReadonlySet<string> = new Set([
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SEGMENT,
  OBJECT_REPORT_ATTR_FILTER,
]);

export function isReportNode(node: MetaData): boolean {
  return node.type === TYPE_OBJECT && node.subType === OBJECT_SUBTYPE_REPORT;
}

// ─── Wording (plain text with `code` spans; the same sentences as report-doc.ts) ───

const tick = (text: string): string => `\`${text.replace(/`/g, "")}\``;
const filterText = (filter: unknown): string => tick(JSON.stringify(filter));

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

function describeRowScope(segment: unknown, filter: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof segment === "string" && segment !== "") parts.push(`segment ${tick(segment)}`);
  if (filter !== undefined && filter !== null) parts.push(`filter ${filterText(filter)}`);
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

function dimensionColumn(dim: MetaData): string {
  // ADR-0039: resolving reads, here and in every describe* below.
  const of = dim.attr(REPORTING_ATTR_OF);
  const via = dim.attr(REPORTING_ATTR_VIA);
  const column = tick(typeof of === "string" ? of : "");
  return typeof via === "string" && via !== "" ? `${column} via ${tick(via)}` : column;
}

function describeDimension(dim: MetaData): string {
  const column = dimensionColumn(dim);
  if (dim.subType !== DIMENSION_SUBTYPE_TIME) return column;
  return `${column}; grains: ${stringList(dim.attr(REPORTING_ATTR_GRAINS)).join(", ")}`;
}

function describeDimensionColumn(dim: MetaData, grain: string | undefined): string {
  const column = dimensionColumn(dim);
  if (grain === undefined) return column;
  const joiner = column.includes(" via ") ? "," : "";
  return `${column}${joiner} truncated to ${grain}, UTC`;
}

function describeMeasure(measure: MetaData): string {
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

function describeReportField(field: ReportField): string {
  if (field.dimension !== undefined) return describeDimensionColumn(field.dimension, field.grain);
  return field.measure !== undefined ? describeMeasure(field.measure) : "";
}

function notServedReason(report: MetaObject): string | undefined {
  if (report.isAbstract === true) return "Not served: the report is abstract";
  const source = reportReadSource(report);
  if (source === undefined) return "Not served: declares no view source";
  if (source.effectiveKind !== SOURCE_KIND_VIEW) {
    return `Not served: its source is a ${source.effectiveKind}, not a view`;
  }
  return undefined;
}

/** Escape, then turn each `code` span into a <code> element (this render lib does not escape). */
function html(text: string): string {
  return esc(text).replace(/`([^`]*)`/g, "<code>$1</code>");
}

/** Mark a node and every attr it authored as rendered. */
function consume(node: MetaData, cov: CoverageTracker): void {
  cov.consumeNode(node);
  // ADR-0039: own — coverage counts the attrs a node DECLARES (`CoverageTracker.report`
  // walks `ownAttrs()`), so the same layer is what gets marked consumed.
  for (const [name] of node.ownAttrs()) cov.consumeAttr(node, name);
}

// ─── A report's page ───────────────────────────────────────────────────────────

export interface ReportColumnRow { name: string; type: string; nullable: string; role: string; definitionHtml: string; }
export interface ReportSection {
  fromName: string; fromHref: string;
  /** The view a served report is read from. Absent when it is not served. */
  viewName?: string | undefined;
  /** "Not served: …" (Table A). Absent for a served report. */
  notServed?: string | undefined;
  scopeHtml?: string | undefined;
  columns: ReportColumnRow[];
}

export function buildReportSection(dn: DocNode, root: MetaRoot, g: LinkGraph, cov: CoverageTracker): ReportSection {
  // `dn.kind === "object"` and the report subtype are checked by the caller; the
  // `unknown` bridge is the one link-graph.ts uses for the same narrowing.
  const report = dn.node as unknown as MetaObject;
  for (const name of REPORT_RENDERED_ATTRS) if (report.attr(name) !== undefined) cov.consumeAttr(report, name);
  // From `reportShape`, which resolves for a report with no source too.
  const shape = reportShape(report, root);
  const from = g.byFqn(fqnOf(shape.from));
  const notServed = notServedReason(report);
  const scope = describeRowScope(report.attr(OBJECT_REPORT_ATTR_SEGMENT), report.attr(OBJECT_REPORT_ATTR_FILTER));
  return {
    fromName: shape.from.name,
    fromHref: from ? g.relHref(dn.href, from.href) : "",
    viewName: notServed === undefined ? reportReadSource(report)?.physicalName : undefined,
    notServed,
    scopeHtml: scope !== undefined ? html(scope) : undefined,
    columns: shape.fields.map((f) => ({
      name: f.name,
      type: f.typeSource?.resolvedIsArray() === true ? `${f.subType}[]` : f.subType,
      nullable: f.required ? "no" : "yes",
      role: f.role,
      definitionHtml: html(describeReportField(f)),
    })),
  };
}

// ─── The @from entity's page ───────────────────────────────────────────────────

export interface ReportingMemberRow { name: string; kind: string; definitionHtml: string; }
export interface ReportingSection {
  dimensions: ReportingMemberRow[]; measures: ReportingMemberRow[]; segments: ReportingMemberRow[];
  reports: { name: string; href: string }[];
}

/** Undefined when the object declares no reporting member and no report reads from it. */
export function buildReportingSection(dn: DocNode, g: LinkGraph, cov: CoverageTracker): ReportingSection | undefined {
  const o = dn.node;
  if (isReportNode(o)) return undefined;
  const members = (type: string, describe: (n: MetaData) => string, kind: (n: MetaData) => string): ReportingMemberRow[] =>
    // Resolving (`childrenOfType`), so a member declared on an abstract base shows on
    // every entity that inherits it, which is where a report may name it from.
    o.childrenOfType(type).map((n) => {
      consume(n, cov);
      return { name: n.name, kind: kind(n), definitionHtml: html(describe(n)) };
    });
  const dimensions = members(TYPE_DIMENSION, describeDimension, (n) => (n.subType === DIMENSION_SUBTYPE_TIME ? "time" : ""));
  const measures = members(TYPE_MEASURE, describeMeasure, () => "");
  const segments = members(TYPE_SEGMENT, (n) => filterText(n.attr(REPORTING_ATTR_FILTER) ?? {}), () => "");
  const reports = g.refsTo(fqnOf(o))
    .filter((r) => r.kind === "report")
    .map((r) => g.byFqn(r.from))
    .filter((r): r is DocNode => r !== undefined)
    .map((r) => ({ name: r.name, href: g.relHref(dn.href, r.href) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (dimensions.length + measures.length + segments.length + reports.length === 0) return undefined;
  return { dimensions, measures, segments, reports };
}
