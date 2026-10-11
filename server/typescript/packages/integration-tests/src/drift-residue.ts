import type { Change } from "@metaobjectsdev/migrate-ts";

/** A change that touches a managed VIEW: created, dropped, or recreated around base-table drift. */
export function isViewChange(c: Change): boolean {
  return c.kind === "create-view" || c.kind === "drop-view" || c.kind === "replace-view";
}

/** The `all_types` columns whose lack of a SQLite storage class produces the residue below. */
export const INET_COLUMNS: ReadonlySet<string> = new Set(["inetVal", "inet6Val"]);

/**
 * The KNOWN residue the SQLite lanes tolerate — named once, because the two tests that
 * filter it (`report-views-sqlite.test.ts`, `view-recreate-drift-sqlite.test.ts`) otherwise
 * drift from each other on the next shift, as they did when this widened.
 *
 * `field.inet` has no SQLite storage class of its own: the canonical model's `all_types`
 * table declares two inet columns, SQLite introspects them back as TEXT, and the diff
 * reports a blocked `text -> inet` change on every run. That is a property of the table,
 * not of any report — and the one report view that reads `all_types` (`AllTypesBreakdown`)
 * is recreated around that blocked table change, which the diff says so (reason
 * `unchanged`, on `all_types`): it is residue of the same table drift, not a view that
 * differs.
 *
 * Named, not swallowed: a column-type change on any OTHER table, or a view recreated with
 * any other reason, fails the lane that filters this.
 */
export function isInetResidue(c: Change): boolean {
  return (
    (c.kind === "change-column-type" && c.table === "all_types" && INET_COLUMNS.has(c.column) &&
      c.to.kind === "inet") ||
    (isViewChange(c) && "reason" in c && c.reason?.kind === "unchanged" && c.reason.tables.join() === "all_types")
  );
}
