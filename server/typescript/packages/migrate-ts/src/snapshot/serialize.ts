// src/snapshot/serialize.ts
import type { SchemaSnapshot } from "../types.js";

/**
 * On-disk format version for the committed schema snapshot. Bump when the
 * SchemaSnapshot descriptor gains a field (a DDL-coverage feature); add the
 * matching upgrade branch in parseSnapshot at the same time.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

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
  // v1 is the only version today. Future versions add upgrade branches here
  // (read older shape, lift it forward) before returning.
  return file.snapshot;
}
