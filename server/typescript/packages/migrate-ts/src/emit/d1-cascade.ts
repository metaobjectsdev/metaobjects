import type { Change, SchemaSnapshot, TableDescriptor } from "../types.js";
import {
  renderCreateTable,
  renderCreateIndex,
  computeCarryColumns,
  changeTable,
  quote,
} from "./sqlite.js";
import { buildFkEdges, unionEdges, affectedSet, topoOrder } from "./fk-graph.js";

/**
 * Prefix for the transient rebuild tables the cascade recipe creates
 * (`__f_<table>`). Distinct from SQLite's own `__new_<table>` recreate temp so
 * the two recipes never collide.
 */
const TEMP_TABLE_PREFIX = "__f_";

/**
 * Result of the D1 FK-cascade emitter: either a validated cascade (with the
 * affected-table set so the dispatcher can partition the remaining changes) or a
 * refusal because the affected tables form a foreign-key cycle.
 */
export type D1CascadeResult =
  | { up: string; downWarning: string; affected: Set<string> }
  | { refuseCycle: string[] };

/**
 * Emit the D1-legal FK-cascade rebuild for a set of recreated tables and every
 * table transitively referencing them.
 *
 * On remote D1 the plain SQLite recreate-and-copy recipe fails: its `PRAGMA
 * foreign_keys = OFF` is a no-op inside D1's implicit transaction, so dropping a
 * referenced table raises "FOREIGN KEY constraint failed". This emitter instead
 * rebuilds the WHOLE affected set inside one implicit transaction, deferring FK
 * enforcement to commit via `PRAGMA defer_foreign_keys = ON`:
 *
 *   1. `PRAGMA defer_foreign_keys = ON;`
 *   2. CREATE `__f_<t>` for each affected `t` (FKs whose target is also affected
 *      are rewritten to the target's temp name).
 *   3. INSERT the carried columns from each old table into its temp.
 *   4. DROP the old tables referrers-first (reverse topological order).
 *   5. RENAME each temp to the real name parents-first (topological order),
 *      recreating that table's indexes immediately after its rename.
 *
 * No `BEGIN/COMMIT` and no `foreign_keys = OFF/ON` bracket: D1 runs the file in
 * one implicit transaction and the safety pass would strip the former anyway.
 *
 * `renderD1` only calls this when `actualSchema` is present, so it is required.
 */
export function emitD1Cascade(
  changes: readonly Change[],
  expectedSchema: SchemaSnapshot,
  actualSchema: SchemaSnapshot,
  recreatedTables: ReadonlySet<string>,
): D1CascadeResult {
  const edges = unionEdges(buildFkEdges(expectedSchema), buildFkEdges(actualSchema));
  const affectedAll = affectedSet(recreatedTables, edges);

  // Restrict to tables that EXIST in the actual DB. `affectedSet` walks the
  // expected edges too, so a brand-new table (created this migration) with an FK
  // into a rebuilt table is pulled in as a referrer — but it cannot be
  // INSERT...SELECTed or DROPped. New tables flow through the native "rest" path,
  // emitted after the cascade so the renamed parent already exists.
  const actualNames = new Set(actualSchema.tables.map((t) => t.name));
  const affected = new Set<string>([...affectedAll].filter((t) => actualNames.has(t)));

  const { order, cycle } = topoOrder(affected, edges);
  if (cycle) return { refuseCycle: cycle };

  const expectedByName = new Map(expectedSchema.tables.map((t) => [t.name, t] as const));
  const expectedTable = (name: string): TableDescriptor => {
    const d = expectedByName.get(name);
    if (!d) throw new Error(`expectedSchema missing table "${name}" needed for D1 FK-cascade`);
    return d;
  };
  const temp = (name: string): string => TEMP_TABLE_PREFIX + name;

  const stmts: string[] = [];

  // Defer FK enforcement to commit — the D1-legal alternative to the (no-op) OFF bracket.
  stmts.push("PRAGMA defer_foreign_keys = ON;");

  // CREATE temps. FK targets inside the affected set are rewritten to their temp
  // name (forward-refs are fine — SQLite resolves FK targets lazily); targets
  // outside the set keep their real name.
  for (const t of order) {
    const src = expectedTable(t);
    const clone: TableDescriptor = {
      ...src,
      name: temp(t),
      foreignKeys: src.foreignKeys.map((fk) =>
        affected.has(fk.refTable) ? { ...fk, refTable: temp(fk.refTable) } : fk,
      ),
    };
    stmts.push(renderCreateTable(clone));
  }

  // INSERT carried columns. A referrer-only table has no changes → carry every
  // expected column (computeCarryColumns([], …)).
  for (const t of order) {
    const tableChanges = changes.filter((c) => changeTable(c) === t);
    const { insertCols, selectCols } = computeCarryColumns(tableChanges, expectedTable(t));
    if (insertCols.length > 0) {
      stmts.push(
        `INSERT INTO ${quote(temp(t))} (${insertCols.map(quote).join(", ")}) ` +
          `SELECT ${selectCols.map(quote).join(", ")} FROM ${quote(t)};`,
      );
    }
  }

  // DROP referrers-first (reverse topological order).
  for (const t of [...order].reverse()) {
    stmts.push(`DROP TABLE ${quote(t)};`);
  }

  // RENAME parents-first; recreate each table's indexes immediately after rename.
  for (const t of order) {
    stmts.push(`ALTER TABLE ${quote(temp(t))} RENAME TO ${quote(t)};`);
    for (const ix of expectedTable(t).indexes) {
      stmts.push(renderCreateIndex(t, ix));
    }
  }

  const up = stmts.join("\n\n");

  // Best-effort down, mirroring renderRecreate's WARNING block.
  const downWarning = [
    `-- WARNING: SQLite recreate-and-copy down migration is best-effort.`,
    `-- Reverse the column type/nullable/default changes by hand if needed.`,
    `-- Dropped data cannot be restored.`,
  ].join("\n");

  return { up, downWarning, affected };
}
