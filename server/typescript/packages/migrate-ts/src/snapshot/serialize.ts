// src/snapshot/serialize.ts
import type { SchemaSnapshot } from "../types.js";

/**
 * On-disk format version for the committed schema snapshot. Bump when the
 * SchemaSnapshot descriptor gains a field (a DDL-coverage feature); add the
 * matching upgrade branch in parseSnapshot at the same time.
 *
 * v3 — ViewDescriptor gained `fingerprint`, `columns` and `dependents`. The
 * fingerprint is how Postgres decides whether a view is up to date (Postgres deparses
 * view SQL, so the emitted text can never be compared against what it stores). A
 * toolchain that does not understand these fields would silently fall back to the old
 * text comparison and re-propose every view on every migrate — so a v3 snapshot must
 * hard-fail on an older reader rather than be quietly misread. Reading an OLDER (v2)
 * snapshot stays fine: the missing fields read as `undefined`, which every consumer
 * treats as "unknown" and fails safe on.
 *
 * NOTE for anyone touching canonicalize(): a view's `columns` array is ORDER-SENSITIVE.
 * Postgres allows a non-destructive CREATE OR REPLACE only when the old column list is
 * a PREFIX of the new one, so sorting that array would destroy the very information the
 * decision rests on.
 */
export const SNAPSHOT_FORMAT_VERSION = 3;

interface SnapshotFile {
  formatVersion: number;
  snapshot: SchemaSnapshot;
}

function sortByName<T extends { name: string }>(arr: readonly T[]): T[] {
  return [...arr].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sort arrays by name so serialization is order-independent. */
function canonicalize(s: SchemaSnapshot): SchemaSnapshot {
  return {
    tables: sortByName(s.tables).map((t) => ({
      ...t,
      columns: sortByName(t.columns),
      indexes: sortByName(t.indexes),
      foreignKeys: sortByName(t.foreignKeys),
      checks: sortByName(t.checks ?? []),
    })),
    views: sortByName(s.views),
    ...(s.meta ? { meta: s.meta } : {}),
  };
}

/** JSON.stringify with object keys sorted recursively (arrays left as-is). */
function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
      }
      return v;
    },
    2,
  );
}

export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  const file: SnapshotFile = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    snapshot: canonicalize(snapshot),
  };
  return stableStringify(file) + "\n";
}

export function parseSnapshot(text: string): SchemaSnapshot {
  const file = JSON.parse(text) as SnapshotFile;
  if (typeof file.formatVersion !== "number") {
    throw new Error("snapshot file is missing a numeric 'formatVersion'");
  }
  if (file.formatVersion > SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshot formatVersion ${file.formatVersion} is newer than supported ` +
        `${SNAPSHOT_FORMAT_VERSION}; upgrade @metaobjectsdev/migrate-ts`,
    );
  }
  if (file.snapshot === null || typeof file.snapshot !== "object") {
    throw new Error("snapshot file is missing a 'snapshot' object");
  }
  if (file.formatVersion < 2) {
    // v1 → v2: the table descriptor gained `checks`; default older snapshots to [].
    for (const t of file.snapshot.tables) {
      if ((t as { checks?: unknown }).checks === undefined) {
        (t as { checks: unknown[] }).checks = [];
      }
    }
  }
  return file.snapshot;
}
