// view-change-reason.ts — reading a view change's `reason` (D3).
//
// `diff` attaches a `ViewChangeReason` to every view change it plans. This module answers
// the one question every drift report needs from it: is this change drift at all?

import type { Change, SchemaAdvisory } from "./types.js";
import { sqlNamesIdentifier } from "./view-reads.js";

/**
 * True for a view change whose definition matches the metadata: half of the drop/create
 * pair a migration needs only because it alters a table the view reads. The pair belongs
 * in the migration SQL; it does not belong in a drift report, where it reads as a view
 * that differs. A change with no reason is not recreate-only, so it stays reported.
 */
export function isViewRecreateOnly(c: Change): boolean {
  return (c.kind === "create-view" || c.kind === "drop-view") && c.reason?.kind === "unchanged";
}

/** `changes` without the recreate-only view changes — what a drift report lists. */
export function withoutViewRecreates<C extends Change>(changes: readonly C[]): C[] {
  return changes.filter((c) => !isViewRecreateOnly(c));
}

/**
 * Views this change set (re)creates whose body still names a column the same change set
 * renames, on the renamed column's table. A declared rename rewrites the table, never a view
 * body: an `@sql` view is created from its text as written, so a body left on the old name
 * fails at apply ("column … does not exist"), long after `meta migrate` and `meta verify`
 * passed. A textual match, so it can over-report; it is an advisory, never a block.
 */
export function viewsNamingRenamedColumns(changes: readonly Change[]): SchemaAdvisory[] {
  const renames = changes.flatMap((c) => (c.kind === "rename-column" ? [c] : []));
  if (renames.length === 0) return [];
  const out: SchemaAdvisory[] = [];
  for (const c of changes) {
    if (c.kind !== "create-view" || c.view.sql === undefined) continue;
    for (const r of renames) {
      if (sqlNamesIdentifier(c.view.sql, r.from) && sqlNamesIdentifier(c.view.sql, r.table)) {
        out.push({
          kind: "view-names-renamed-column",
          table: r.table,
          ...(r.schema !== undefined ? { schema: r.schema } : {}),
          column: r.from,
          to: r.to,
          view: c.view.name,
        });
      }
    }
  }
  return out;
}
