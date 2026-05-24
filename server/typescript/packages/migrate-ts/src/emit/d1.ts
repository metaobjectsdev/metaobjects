import type { Change, EmitResult, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { renderSqlite } from "./sqlite.js";
import { applyD1SafetyPass } from "./d1-safety-pass.js";

export function renderD1(
  changes: Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);
  return {
    up: applyD1SafetyPass(sqliteResult.up),
    down: applyD1SafetyPass(sqliteResult.down),
    recreatedTables: sqliteResult.recreatedTables,
  };
}
