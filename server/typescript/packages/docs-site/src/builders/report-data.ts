// FR-044 on the HTML site (Table G of the Plan 3 spec):
//
//   • an `object.report`'s page gets a "Report" section: its `@from` (linked), the view it
//     is read from or why it is not served, its row scope, and one row per derived column
//     from `reportShape`;
//   • the page of an entity that declares dimensions, measures or segments, or that a
//     report names as its `@from`, gets a "Reporting" section.
//
// The sentences come from `@metaobjectsdev/metadata` (`core/reporting/report-describe.ts`),
// the same describers the markdown model pages use, so the two surfaces cannot disagree.
// This module only turns their `code` spans into HTML.

import type { MetaData, MetaRoot } from "@metaobjectsdev/metadata";
import {
  DIMENSION_SUBTYPE_TIME,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SEGMENT,
  OBJECT_SUBTYPE_REPORT,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_OBJECT,
  TYPE_SEGMENT,
  describeDimension,
  describeMeasure,
  describeReportField,
  describeRowScope,
  describeSegment,
  isMetaObject,
  reportFieldTypeName,
  reportNotServedReason,
  reportReadSource,
  reportShape,
  reportingDescribedAttrs,
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

/** Escape, then turn each `code` span into a <code> element (this render lib does not escape). */
function html(text: string): string {
  return esc(text).replace(/`([^`]*)`/g, "<code>$1</code>");
}

/**
 * Mark a dimension, measure or segment as rendered, with exactly the attrs its describer
 * prints (`reportingDescribedAttrs`). Anything else authored on the node stays unconsumed,
 * so the coverage audit reports it as a gap instead of claiming a page shows it.
 */
function consumeDescribed(node: MetaData, cov: CoverageTracker): void {
  cov.consumeNode(node);
  for (const name of reportingDescribedAttrs(node)) {
    // ADR-0039: resolving, the read the describer itself makes.
    if (node.attr(name) !== undefined) cov.consumeAttr(node, name);
  }
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
  const report = dn.node;
  if (!isMetaObject(report)) throw new Error(`not a report object: ${fqnOf(report)}`);
  for (const name of REPORT_RENDERED_ATTRS) if (report.attr(name) !== undefined) cov.consumeAttr(report, name);
  // From `reportShape`, which resolves for a report with no source too.
  const shape = reportShape(report, root);
  const from = g.byFqn(fqnOf(shape.from));
  const notServed = reportNotServedReason(report);
  const scope = describeRowScope(report.attr(OBJECT_REPORT_ATTR_SEGMENT), report.attr(OBJECT_REPORT_ATTR_FILTER));
  return {
    fromName: shape.from.name,
    fromHref: from ? g.relHref(dn.href, from.href) : "",
    viewName: notServed === undefined ? reportReadSource(report)?.physicalName : undefined,
    notServed,
    scopeHtml: scope !== undefined ? html(scope) : undefined,
    columns: shape.fields.map((f) => ({
      name: f.name,
      type: reportFieldTypeName(f),
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
      consumeDescribed(n, cov);
      return { name: n.name, kind: kind(n), definitionHtml: html(describe(n)) };
    });
  const dimensions = members(TYPE_DIMENSION, describeDimension, (n) => (n.subType === DIMENSION_SUBTYPE_TIME ? "time" : ""));
  const measures = members(TYPE_MEASURE, describeMeasure, () => "");
  const segments = members(TYPE_SEGMENT, describeSegment, () => "");
  const reports = g.refsTo(fqnOf(o))
    .filter((r) => r.kind === "report")
    .map((r) => g.byFqn(r.from))
    .filter((r): r is DocNode => r !== undefined)
    .map((r) => ({ name: r.name, href: g.relHref(dn.href, r.href) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (dimensions.length + measures.length + segments.length + reports.length === 0) return undefined;
  return { dimensions, measures, segments, reports };
}
