// What `meta docs` says about the FR-044 reporting vocabulary on the neutral model
// surface (Table G of the Plan 3 spec):
//
//   • a REPORT's page: its `@from`, the view it is read from (or why it is not served),
//     its row scope, and one row per derived column, from `reportShape`;
//   • the `@from` ENTITY's page: a "Reporting" section listing the dimensions, measures
//     and segments it declares and the reports that name it.
//
// Everything is read from declared metadata. No SQL is derived here: a definition says
// what a column means ("sum of `Invoice.amountCents` where segment `paid`"), never how
// the view computes it. `docs-site` renders the same sentences on the HTML site from its
// own copy of these rules (it does not depend on this package); its tests hold the two
// together.

import {
  type MetaData,
  type MetaObject,
  type MetaRoot,
  type ReportField,
  DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_RATIO,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
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
  TYPE_SEGMENT,
  isMetaObject,
  reportFrom,
  reportReadSource,
  reportShape,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import type { OutputLayout } from "../import-path.js";
import { docPageHref, docPageNode, effectivePackage } from "../docs-paths.js";
import { isReport } from "../source-detect.js";

/** Inline code. A backtick cannot sit inside a single-backtick span, so it is dropped. */
function tick(text: string): string {
  return `\`${text.replace(/`/g, "")}\``;
}

/** A row-scope filter as authored: compact JSON, in the order it was declared. */
function filterText(filter: unknown): string {
  return tick(JSON.stringify(filter));
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/**
 * "segment `paid` and filter `{…}`": the rows a measure or a report is scoped to, or
 * undefined when it declares neither. The two combine by AND, which is what the lowering
 * does with them.
 */
export function describeRowScope(segment: unknown, filter: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof segment === "string" && segment !== "") parts.push(`segment ${tick(segment)}`);
  if (filter !== undefined && filter !== null) parts.push(`filter ${filterText(filter)}`);
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/** "`Program.title` via `Purchase.program`": the column a dimension groups by. */
function dimensionColumn(dim: MetaData): string {
  // ADR-0039: resolving, so a dimension that extends another reads its effective @of/@via.
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

/** A dimension as ONE report column: a time dimension is truncated to the report's grain. */
function describeDimensionColumn(dim: MetaData, grain: string | undefined): string {
  const column = dimensionColumn(dim);
  if (grain === undefined) return column;
  // Reports are UTC only (Plan 3 global constraint): there is no time-zone vocabulary.
  const joiner = column.includes(" via ") ? "," : "";
  return `${column}${joiner} truncated to ${grain}, UTC`;
}

/** A measure in words: the aggregate and its row scope, or the ratio and its null rule. */
export function describeMeasure(measure: MetaData): string {
  // ADR-0039: resolving reads throughout, as for a dimension.
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

/** One derived column's definition, from the dimension or measure it comes from. */
export function describeReportField(field: ReportField): string {
  if (field.dimension !== undefined) return describeDimensionColumn(field.dimension, field.grain);
  return field.measure !== undefined ? describeMeasure(field.measure) : "";
}

/** The neutral logical type of a derived column: its Table B subtype, `[]` for an array. */
export function reportFieldType(field: ReportField): string {
  // ADR-0039: resolvedIsArray() is the resolving read of the native array flag.
  return field.typeSource?.resolvedIsArray() === true ? `${field.subType}[]` : field.subType;
}

/**
 * Why a report is not served, or undefined when it is (Table A). The wording is the
 * spec's for the common case: a report that declares no source at all.
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

/** A markdown table cell: a pipe would end the cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * The body of a report page's "Report" section: `@from` (linked), the view or the
 * not-served line, the row scope, and the column table.
 *
 * Built from `reportShape`, which resolves for a report with no source, and not from the
 * read model, which exists only to give a SERVED report ordinary fields.
 */
export function buildReportBlock(report: MetaObject, root: MetaRoot, layout: OutputLayout): string {
  const shape = reportShape(report, root);
  const lines: string[] = [];
  const fromHref = docPageHref(layout, docPageNode(report), docPageNode(shape.from));
  lines.push(`**From:** [${shape.from.name}](${fromHref})`);
  const notServed = reportNotServedReason(report);
  lines.push(`**View:** ${notServed ?? tick(reportReadSource(report)?.physicalName ?? "")}`);
  // ADR-0039: resolving.
  const scope = describeRowScope(report.attr(OBJECT_REPORT_ATTR_SEGMENT), report.attr(OBJECT_REPORT_ATTR_FILTER));
  if (scope !== undefined) lines.push(`**Row scope:** ${scope}`);
  if (shape.fields.length > 0) {
    lines.push("", "| Column | Type | Nullable | Role | Definition |", "|---|---|---|---|---|");
    for (const f of shape.fields) {
      lines.push(
        `| ${tick(f.name)} | ${tick(reportFieldType(f))} | ${f.required ? "no" : "yes"} | ${f.role} | ${cell(describeReportField(f))} |`,
      );
    }
  }
  return lines.join("\n");
}

/** The reports whose `@from` resolves to `entity`, in declaration order. */
function reportsFrom(entity: MetaObject, root: MetaRoot): MetaObject[] {
  return root.objects().filter((o) => {
    if (!isReport(o)) return false;
    const from = reportFrom(o);
    if (from === undefined) return false;
    // A bare @from resolves in the REPORT's package, as `reportShape` resolves it.
    const target = resolveObjectRef(root, from, effectivePackage(o) ?? "").node;
    return isMetaObject(target) && target === entity;
  });
}

/**
 * The body of an entity page's "Reporting" section, or undefined when the entity
 * declares no dimension, measure or segment and no report names it. Undefined, not
 * empty: the page of an entity that has nothing to do with reporting must not move.
 */
export function buildReportingBlock(entity: MetaObject, root: MetaRoot, layout: OutputLayout): string | undefined {
  if (isReport(entity)) return undefined;
  // ADR-0039: resolving children(), so a member declared on an abstract base shows on
  // every entity that inherits it, which is where a report may name it from.
  const members = entity.children();
  const groups: Array<[string, string[]]> = [
    ["Dimensions", members.filter((c) => c.type === TYPE_DIMENSION).map((d) =>
      `- ${tick(d.name)}${d.subType === DIMENSION_SUBTYPE_TIME ? " (time)" : ""} — ${describeDimension(d)}`)],
    ["Measures", members.filter((c) => c.type === TYPE_MEASURE).map((m) =>
      `- ${tick(m.name)} — ${describeMeasure(m)}`)],
    ["Segments", members.filter((c) => c.type === TYPE_SEGMENT).map((s) =>
      `- ${tick(s.name)} — ${filterText(s.attr(REPORTING_ATTR_FILTER) ?? {})}`)],
    ["Reports", reportsFrom(entity, root)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => `- [${r.name}](${docPageHref(layout, docPageNode(entity), docPageNode(r))})`)],
  ];
  const present = groups.filter(([, bullets]) => bullets.length > 0);
  if (present.length === 0) return undefined;
  return present.map(([title, bullets]) => `**${title}**\n\n${bullets.join("\n")}`).join("\n\n");
}
