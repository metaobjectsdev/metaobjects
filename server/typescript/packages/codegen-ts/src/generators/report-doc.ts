// What `meta docs` says about the FR-044 reporting vocabulary on the neutral model
// surface (Table G of the Plan 3 spec):
//
//   • a REPORT's page: its `@from`, the view it is read from (or why it is not served),
//     its row scope, and one row per derived column, from `reportShape`;
//   • the `@from` ENTITY's page: a "Reporting" section listing the dimensions, measures
//     and segments it declares and the reports that name it.
//
// The SENTENCES come from `@metaobjectsdev/metadata` (`core/reporting/report-describe.ts`),
// which `docs-site` reads too, so the markdown pages and the HTML site cannot disagree.
// This module only lays them out as markdown.

import {
  type MetaObject,
  type MetaRoot,
  DIMENSION_SUBTYPE_TIME,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_SEGMENT,
  describeDimension,
  describeMeasure,
  describeReportField,
  describeReportRowScope,
  describeReportRows,
  describeSegment,
  isMetaObject,
  reportFieldTypeName,
  reportFrom,
  reportNotServedReason,
  reportReadSource,
  reportShape,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import type { OutputLayout } from "../import-path.js";
import { docPageHref, docPageNode, effectivePackage } from "../docs-paths.js";
import { isReport } from "../source-detect.js";

/** Inline code for a name this module prints itself (the describers return theirs ready). */
function tick(text: string): string {
  return `\`${text.replace(/`/g, "")}\``;
}

/** A markdown table cell: a pipe would end the cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * The body of a report page's "Report" section: `@from` (linked), the view or the
 * not-served line, where a `@spine` report's rows come from, the row scope, and the column
 * table.
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
  // Only a report with `@spine` has a Rows line; without one the page is as it was.
  const rows = describeReportRows(shape, root);
  if (rows !== undefined) lines.push(`**Rows:** ${rows}`);
  const scope = describeReportRowScope(report);
  if (scope !== undefined) lines.push(`**Row scope:** ${scope}`);
  if (shape.fields.length > 0) {
    lines.push("", "| Column | Type | Nullable | Role | Definition |", "|---|---|---|---|---|");
    for (const f of shape.fields) {
      lines.push(
        `| ${tick(f.name)} | ${tick(reportFieldTypeName(f))} | ${f.required ? "no" : "yes"} | ${f.role} | ${cell(describeReportField(f))} |`,
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
      `- ${tick(s.name)} — ${describeSegment(s)}`)],
    ["Reports", reportsFrom(entity, root)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => `- [${r.name}](${docPageHref(layout, docPageNode(entity), docPageNode(r))})`)],
  ];
  const present = groups.filter(([, bullets]) => bullets.length > 0);
  if (present.length === 0) return undefined;
  return present.map(([title, bullets]) => `**${title}**\n\n${bullets.join("\n")}`).join("\n\n");
}
