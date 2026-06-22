import type { Change, EmitResult, Dialect, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { BlockedChangesError } from "../errors.js";
import { renderPostgres } from "./postgres.js";
import { renderSqlite } from "./sqlite.js";
import { renderD1 } from "./d1.js";
// View DDL is rendered by every dialect renderer (see their create/drop/replace-view
// cases): postgres uses CREATE [OR REPLACE] VIEW with schema namespacing; sqlite/d1
// use DROP+CREATE (no CREATE OR REPLACE, no schema). There is no dialect gate here.

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

export function emit(changes: Change[], opts: EmitOptions): EmitResult {
  const blocked = changes.filter((c) => c.status.state === "blocked");
  if (blocked.length > 0) throw new BlockedChangesError(blocked);

  switch (opts.dialect) {
    case "postgres": return renderPostgres(changes);
    case "sqlite":   return renderSqlite(changes, opts.expectedSchema, opts.actualMeta);
    case "d1":       return renderD1(changes, opts.expectedSchema, opts.actualMeta);
  }
}
