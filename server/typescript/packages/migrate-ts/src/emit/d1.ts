import type { Change, EmitResult, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { renderSqlite } from "./sqlite.js";
import { applyD1SafetyPass } from "./d1-safety-pass.js";
import { findReferencedRebuilds, D1ReferencedTableRebuildError } from "./d1-fk-refuse.js";

export function renderD1(
  changes: readonly Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
  /** Used by the #241 cascade (Task 4) to build the actual∪expected FK graph. Unused for now. */
  actualSchema?: SchemaSnapshot,
): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);

  // #226: a rebuild (recreate-and-copy) of a table referenced by a foreign key cannot
  // apply on remote D1 — the recipe's `PRAGMA foreign_keys = OFF` is a no-op inside
  // D1's implicit transaction, so `DROP TABLE <referenced>` fails. Refuse at generation
  // time rather than emit SQL that fails silently against production. renderSqlite has
  // already guaranteed expectedSchema is present when recreatedTables is non-empty.
  if (sqliteResult.recreatedTables.size > 0) {
    const refusals = findReferencedRebuilds(
      sqliteResult.recreatedTables,
      expectedSchema ?? { tables: [], views: [] },
    );
    if (refusals.length > 0) throw new D1ReferencedTableRebuildError(refusals);
  }

  return {
    up: applyD1SafetyPass(sqliteResult.up),
    down: applyD1SafetyPass(sqliteResult.down),
    recreatedTables: sqliteResult.recreatedTables,
  };
}
