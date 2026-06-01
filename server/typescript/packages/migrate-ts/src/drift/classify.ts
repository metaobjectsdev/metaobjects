// src/drift/classify.ts
import { diff } from "../diff/index.js";
import type { Change, Dialect, DiffResult, SchemaSnapshot } from "../types.js";

/**
 * Change kinds that represent an object present in the live DB but absent from
 * the snapshot. When the snapshot is the `expected` side of a diff, these are
 * the DB's *unmanaged* objects — hand-authored, not modeled — and must never be
 * treated as actionable drift or auto-dropped.
 */
const UNMANAGED_KINDS = new Set<string>([
  "drop-table",
  "drop-column",
  "drop-index",
  "drop-fk",
  "drop-view",
]);

export interface DriftClassification {
  /** Modeled objects the DB is missing or has differently — actionable; fails the gate. */
  drift: Change[];
  /** Objects present in the DB but not the snapshot — informational; never dropped. */
  unmanaged: Change[];
}

export function classifyDrift(changes: Change[]): DriftClassification {
  const drift: Change[] = [];
  const unmanaged: Change[] = [];
  for (const c of changes) {
    if (UNMANAGED_KINDS.has(c.kind)) unmanaged.push(c);
    else drift.push(c);
  }
  return { drift, unmanaged };
}

/**
 * Drift of a live DB (introspected into `actual`) against the committed snapshot.
 * Diffs with `expected = snapshot` so that objects only in the DB surface as
 * `drop-*` → classified `unmanaged`; objects the snapshot has but the DB lacks or
 * differs surface as create/add/change → classified `drift`.
 */
export async function driftAgainstSnapshot(
  snapshot: SchemaSnapshot,
  actual: SchemaSnapshot,
  dialect?: Dialect,
): Promise<DriftClassification> {
  const result: DiffResult = await diff({
    expected: snapshot,
    actual,
    ...(dialect !== undefined ? { dialect } : {}),
  });
  return classifyDrift(result.changes);
}
