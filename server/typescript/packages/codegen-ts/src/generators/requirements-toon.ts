// server/typescript/packages/codegen-ts/src/generators/requirements-toon.ts
//
// The machine-facing half of the `requirements` docs surface.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §5
//
// CHOSEN FOR THE DECLARED-COUNT HEADER, NOT THE TOKEN SAVING. Measured with this same
// encoder on 321 rows, TOON is 42.1% smaller than JSON but only 7.3% smaller than a
// markdown table — a table is already header-once, so compression is close to a
// non-argument. What it buys is the header:
//
//   requirements[321]{path,level,status,claims,statement}:
//
// A reader can verify it received all 321 rows. A documentation generator that silently
// drops rows produces a document that looks complete and is not, and this is the one
// cheap defence against that.
//
// PROSE IS DELIBERATELY THIN HERE. TOON quotes every comma-bearing string, so statements
// dilute the format badly. The readable half lives in the markdown sibling; this file
// carries structure. That split is the reason both are emitted rather than one.
//
// `notes` NEVER APPEARS — RequirementRow does not carry it (documentation.json charters
// it internal-only). Nothing to strip, by construction.

import { encode } from "@toon-format/toon";
import type { RequirementRow } from "./requirements-view.js";

/** The row shape the artifact declares. Field ORDER is the wire contract — a reader
 *  diffing two runs sees a reordering as noise, so it is fixed here rather than left
 *  to object-literal order elsewhere. */
interface ToonRow {
  readonly path: string;
  readonly subType: string;
  readonly level: number | string;
  readonly status: string;
  readonly disposition: string;
  readonly claims: string;
  readonly statement: string;
}

/** TOON is tabular: a field absent on one row and present on another breaks the uniform
 *  header. So every optional value collapses to "" rather than being omitted — an empty
 *  cell reads as absent without costing the header its shape. */
function cell(v: string | undefined): string {
  return v ?? "";
}

export function renderRequirementsToon(rows: readonly RequirementRow[]): string {
  if (rows.length === 0) return "";

  const table: ToonRow[] = rows.map((r) => ({
    path: r.path,
    subType: r.subType,
    level: r.level ?? "",
    status: cell(r.status),
    disposition: cell(r.disposition),
    // Joined rather than nested: a nested array per row would cost the tabular header,
    // which is the entire reason this format was picked.
    claims: r.implementedBy.join(" "),
    statement: cell(r.statement),
  }));

  return encode({ requirements: table });
}
