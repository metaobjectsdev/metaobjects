// Which drop-column + add-column pairs in a change list could be a column the author
// RENAMED. A leaf module (it imports no diff hub and no error class) so the rename
// heuristic, the blocked-change error and the CLI's hint text can all read it without an
// import cycle.
//
// Why it exists: a rename the heuristic did not pair (the names are too far apart, e.g.
// `title` → `summary`) reaches the author as a BLOCKED drop plus an add in the same table.
// The permission that unblocks the drop — `allow.dropColumn` / `--allow drop-column` —
// "fixes" that by deleting the column and every value in it. The declared rename keeps the
// data. Every hint on this shape names the rename first, with the real names, so the
// data-losing option is never the only one on the page.

import type { Change, ColumnDescriptor } from "../types.js";
import { sqlTypeEquals } from "../sql-type.js";
import { columnDefaultsEqual } from "../column-default.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";

/** A drop-column + add-column pair in one table that could be a rename. */
export interface ColumnRenameSuggestion {
  /** The table both columns belong to (its metadata-side name). */
  table: string;
  schema?: string;
  /** The column being dropped (live side). */
  from: string;
  /** The column being added (metadata side). */
  to: string;
  /**
   * Set when the two sides also differ in shape. A declared rename of such a pair is
   * refused (one migration cannot rename and reshape a column), so the hint has to say
   * to rename first with the old shape declared.
   */
  shapeChange?: string;
}

/** The first aspect other than the name in which a renamed column's two sides differ. */
export function shapeDifference(live: ColumnDescriptor | undefined, declared: ColumnDescriptor): string | undefined {
  if (live === undefined) return undefined;
  if (!sqlTypeEquals(live.sqlType, declared.sqlType)) {
    return `type (${live.sqlType.kind} → ${declared.sqlType.kind})`;
  }
  if (live.nullable !== declared.nullable) {
    return `nullability (${live.nullable ? "NULL" : "NOT NULL"} → ${declared.nullable ? "NULL" : "NOT NULL"})`;
  }
  if (!columnDefaultsEqual(live.default, declared.default)) return "default";
  if (live.identity !== declared.identity) {
    return `identity (${live.identity ?? "none"} → ${declared.identity ?? "none"})`;
  }
  return undefined;
}

/**
 * Pair each drop-column with at most one add-column in the same (schema, table), preferring
 * an add of the same shape. An add is never offered to two drops. Order follows `changes`.
 */
export function suggestColumnRenames(changes: readonly Change[]): ColumnRenameSuggestion[] {
  const keyOf = (table: string, schema: string | undefined): string =>
    `${schema ?? DEFAULT_DB_SCHEMA_POSTGRES}.${table}`;
  const addsByTable = new Map<string, Extract<Change, { kind: "add-column" }>[]>();
  for (const c of changes) {
    if (c.kind !== "add-column") continue;
    const k = keyOf(c.table, c.schema);
    const arr = addsByTable.get(k) ?? [];
    arr.push(c);
    addsByTable.set(k, arr);
  }

  const out: ColumnRenameSuggestion[] = [];
  for (const c of changes) {
    if (c.kind !== "drop-column") continue;
    const adds = addsByTable.get(keyOf(c.table, c.schema));
    if (adds === undefined || adds.length === 0) continue;
    const pick = adds.find((a) => shapeDifference(c.restore, a.column) === undefined) ?? adds[0]!;
    adds.splice(adds.indexOf(pick), 1);
    const shapeChange = shapeDifference(c.restore, pick.column);
    out.push({
      table: pick.table,
      ...(c.schema !== undefined ? { schema: c.schema } : {}),
      from: c.column,
      to: pick.column.name,
      ...(shapeChange !== undefined ? { shapeChange } : {}),
    });
  }
  return out;
}
