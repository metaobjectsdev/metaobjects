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
//
// BUILDER, THEN TEMPLATE, like the markdown sibling: `requirementsToonData` makes every cell
// a finished TOON literal (quoted where TOON requires it) and the shared template
// `templates/requirements/requirements.toon.mustache` lays the header and rows out. Every
// port renders that template from the same data (`fixtures/docs-page-conformance/`). The
// file ends WITHOUT a line break, as a TOON document does.

import { encode } from "@toon-format/toon";
import type { Provider } from "@metaobjectsdev/render";
import { frameworkTemplatesProvider } from "../render-engine/framework-provider.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import type { RequirementRow } from "./requirements-view.js";

/** The shared template of the machine-facing artifact. */
export const REQUIREMENTS_TOON_REF = "requirements/requirements.toon";

/** The row's columns. ORDER is the wire contract — a reader diffing two runs sees a
 *  reordering as noise, so it is fixed here rather than left to object-literal order. */
export const REQUIREMENTS_TOON_FIELDS = [
  "path",
  "subType",
  "level",
  "status",
  "disposition",
  "claims",
  "statement",
] as const;

/** What `requirements/requirements.toon.mustache` renders. */
export interface RequirementsToonData {
  readonly count: number;
  /** `{path,subType,…}`: the declared header fields, comma-joined in their braces (a
   *  Mustache template cannot write a literal brace beside a tag). */
  readonly fields: string;
  /** Each row as its finished cells, comma-joined: `a.b,functional,4,"",…`. */
  readonly rows: readonly { readonly line: string }[];
}

/**
 * One cell as TOON writes it inside a comma-delimited row: a number bare, a string bare
 * when it is safe and quoted (with TOON's escapes) when it is not — empty, padded, numeric-
 * or literal-looking, or carrying a delimiter, a colon, a quote, a bracket or a control
 * character. Read off the reference encoder rather than re-implemented: a key/value line
 * quotes its value under the same rule a tabular row uses for the default delimiter.
 */
export function toonCell(value: string | number): string {
  return encode({ c: value }).slice("c: ".length);
}

/** TOON is tabular: a field absent on one row and present on another breaks the uniform
 *  header. So every optional value collapses to "" rather than being omitted — an empty
 *  cell reads as absent without costing the header its shape. */
function cell(v: string | undefined): string {
  return v ?? "";
}

/** The data the TOON template renders, for a non-empty ledger. */
export function requirementsToonData(rows: readonly RequirementRow[]): RequirementsToonData {
  return {
    count: rows.length,
    fields: `{${REQUIREMENTS_TOON_FIELDS.join(",")}}`,
    rows: rows.map((r) => ({
      line: [
        r.path,
        r.subType,
        r.level ?? "",
        cell(r.status),
        cell(r.disposition),
        // Joined rather than nested: a nested array per row would cost the tabular header,
        // which is the entire reason this format was picked.
        r.implementedBy.join(" "),
        cell(r.statement),
      ]
        .map(toonCell)
        .join(","),
    })),
  };
}

export function renderRequirementsToon(rows: readonly RequirementRow[], provider?: Provider): string {
  if (rows.length === 0) return "";
  return renderDocPage(
    REQUIREMENTS_TOON_REF,
    requirementsToonData(rows),
    provider ?? frameworkTemplatesProvider,
    "requirements.toon",
  );
}
