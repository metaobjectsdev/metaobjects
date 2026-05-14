import type { Change, EmitResult, Dialect, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { BlockedChangesError } from "../errors.js";
import { renderPostgres } from "./postgres.js";
import { renderSqlite } from "./sqlite.js";

export interface EmitOptions {
  dialect: Dialect;
  /**
   * Required when dialect="sqlite" AND any change triggers recreate-and-copy
   * (change-column-type, change-column-nullable, change-column-default, add-fk, drop-fk).
   * Used to look up the post-migration table descriptor for the recreate recipe.
   */
  expectedSchema?: SchemaSnapshot;
  /**
   * Per spec §7.4: if SQLite version < 3.35 (DROP COLUMN) or < 3.25 (RENAME COLUMN),
   * fall back to recreate-and-copy. Unknown/absent version → assume modern.
   */
  actualMeta?: SnapshotMeta;
}

const VIEW_KINDS = new Set<Change["kind"]>(["create-view", "drop-view", "replace-view"]);

export function emit(changes: Change[], opts: EmitOptions): EmitResult {
  const blocked = changes.filter((c) => c.status.state === "blocked");
  if (blocked.length > 0) throw new BlockedChangesError(blocked);

  const viewChanges = changes.filter((c) => VIEW_KINDS.has(c.kind));
  if (viewChanges.length > 0) {
    throw new Error(
      `view migration not implemented in v0.1 (${viewChanges.length} view-targeting change(s); deferred to v0.3)`,
    );
  }

  switch (opts.dialect) {
    case "postgres": return renderPostgres(changes);
    case "sqlite":   return renderSqlite(changes, opts.expectedSchema, opts.actualMeta);
  }
}
