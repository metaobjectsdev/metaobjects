// view-change-reason.ts — reading a view change's `reason` (D3).
//
// `diff` attaches a `ViewChangeReason` to every view change it plans. This module answers
// the one question every drift report needs from it: is this change drift at all?

import type { Change } from "./types.js";

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
