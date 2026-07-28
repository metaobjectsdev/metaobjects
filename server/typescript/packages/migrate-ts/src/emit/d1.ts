import type { Change, EmitResult, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { renderSqlite, changeTable } from "./sqlite.js";
import { applyD1SafetyPass } from "./d1-safety-pass.js";
import {
  findReferencedRebuilds,
  D1ReferencedTableRebuildError,
  D1CyclicForeignKeyError,
} from "./d1-fk-refuse.js";
import { buildFkEdges, unionEdges } from "./fk-graph.js";
import { emitD1Cascade } from "./d1-cascade.js";

const EMPTY_SCHEMA: SchemaSnapshot = { tables: [], views: [] };

export function renderD1(
  changes: readonly Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
  /** The actual (introspected) DB schema — enables the #241 FK-cascade rebuild. */
  actualSchema?: SchemaSnapshot,
): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);

  // Trigger detection: is any recreated table the target of a foreign key in the
  // expected OR actual schema (a self-reference counts)? Only such rebuilds are
  // un-appliable on D1 — the recipe's `PRAGMA foreign_keys = OFF` is a no-op
  // inside D1's implicit transaction, so `DROP TABLE <referenced>` fails (#226).
  const edges = unionEdges(
    buildFkEdges(expectedSchema ?? EMPTY_SCHEMA),
    actualSchema ? buildFkEdges(actualSchema) : new Map<string, Set<string>>(),
  );
  const isReferenced = (t: string): boolean => {
    for (const parents of edges.values()) {
      if (parents.has(t)) return true;
    }
    return false;
  };
  const referenced = [...sqliteResult.recreatedTables].filter(isReferenced);

  // No referenced rebuild → byte-identical to the pre-#241 path.
  if (referenced.length === 0) {
    return {
      up: applyD1SafetyPass(sqliteResult.up),
      down: applyD1SafetyPass(sqliteResult.down),
      recreatedTables: sqliteResult.recreatedTables,
    };
  }

  // A referenced rebuild exists. Without the actual schema we cannot prove a
  // cascade is safe, so refuse exactly as #226 does — never emit an unproven one.
  if (actualSchema === undefined) {
    throw new D1ReferencedTableRebuildError(
      findReferencedRebuilds(sqliteResult.recreatedTables, expectedSchema ?? EMPTY_SCHEMA),
    );
  }

  // recreatedTables non-empty ⇒ renderSqlite already guaranteed expectedSchema.
  const cascade = emitD1Cascade(changes, expectedSchema!, actualSchema, sqliteResult.recreatedTables);
  if ("refuseCycle" in cascade) {
    throw new D1CyclicForeignKeyError(cascade.refuseCycle);
  }

  // Splice: the affected set is rebuilt by the cascade; every other change flows
  // through the native path, emitted AFTER the cascade so renamed parents exist
  // before any native CREATE TABLE referencing them. `defer_foreign_keys = ON`
  // persists across the whole implicit transaction, so FK checks defer to commit
  // where the final state is consistent.
  const { up: cascadeUp, downWarning, affected } = cascade;
  const nonAffected = changes.filter((c) => {
    const t = changeTable(c);
    return !(t !== undefined && affected.has(t));
  });
  const rest = renderSqlite(nonAffected, expectedSchema, actualMeta);

  const up = [cascadeUp, rest.up].filter((s) => s.length > 0).join("\n\n");
  const down = [rest.down, downWarning].filter((s) => s.length > 0).join("\n\n");

  return {
    up: applyD1SafetyPass(up),
    down: applyD1SafetyPass(down),
    recreatedTables: new Set([...affected, ...rest.recreatedTables]),
  };
}
