// computeDrift — structural + view-body drift of a live DB vs the metadata-
// declared schema. Thin composition over the existing pipeline:
//   buildExpectedSchema(metadata) + introspect(db, dialect) → diff(...)
//
// Used by the `meta verify --db` schema-drift gate: a non-empty `changes` list
// means the live DB has diverged from what the metadata describes (a missing
// column, a changed view body, an extra table, etc.). Unlike `meta migrate`,
// drift detection never emits SQL or asks about ambiguous renames — it just
// reports the divergence so CI can fail loud.

import type { Kysely } from "kysely";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../expected-schema.js";
import { introspect } from "../introspect/index.js";
import { diff } from "../diff/index.js";
import type { AllowOptions, Dialect, DiffResult } from "../types.js";

export interface ComputeDriftOptions {
  /**
   * Destructive-change permissions. Mirrors `diff`'s `allow` — a drift that is
   * "allowed" still appears in `changes` (it's still drift), so the gate fails
   * on it. `allow` only affects `blocked`. Defaults to `{}`.
   */
  allow?: AllowOptions;
  /**
   * Column-naming strategy for fields with no `@column` override. Must match
   * the runtime's strategy or the expected schema's columns won't line up with
   * what introspection sees. Defaults to `buildExpectedSchema`'s default.
   */
  columnNamingStrategy?: ColumnNamingStrategy;
  /**
   * Table-name patterns to ignore on both sides (passed through to `diff`).
   * Omit to keep `diff`'s default (migration-tracking sidecar tables).
   */
  ignoreTables?: string[];
}

/**
 * Compute the drift between a live DB and the metadata-declared schema.
 *
 * Returns a `DiffResult` whose `changes` is empty iff the DB matches the
 * metadata. The caller decides exit behavior (the schema-drift gate fails when
 * `changes` is non-empty).
 */
export async function computeDrift(
  db: Kysely<Record<string, unknown>>,
  dialect: Dialect,
  metadata: MetaRoot,
  opts?: ComputeDriftOptions,
): Promise<DiffResult> {
  const expected = buildExpectedSchema(metadata, {
    dialect,
    ...(opts?.columnNamingStrategy !== undefined
      ? { columnNamingStrategy: opts.columnNamingStrategy }
      : {}),
  });
  const actual = await introspect(db, dialect);
  return diff({
    expected,
    actual,
    dialect,
    allow: opts?.allow ?? {},
    ...(opts?.ignoreTables !== undefined ? { ignoreTables: opts.ignoreTables } : {}),
  });
}
