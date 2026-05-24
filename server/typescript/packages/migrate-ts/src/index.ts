// Public API surface for @metaobjectsdev/migrate-ts v0.1.0
//
// Architecture: pure pipeline — buildExpectedSchema(metadata) +
// introspect(db, dialect) → SchemaSnapshot; diff(expected, actual, opts)
// → Change[]; emit(changes, opts) → { up, down }; writeMigration(...)
// writes the pair to disk.
//
// See docs/specs/2026-05-11-v0.2-sp4-migrate-ts-design.md.

// Pipeline functions
export { buildExpectedSchema } from "./expected-schema.js";
export { introspect, introspectPostgres, introspectSqlite } from "./introspect/index.js";
export { diff } from "./diff/index.js";
export { emit } from "./emit/index.js";
export { writeMigration } from "./write-migration.js";

// Errors
export { BlockedChangesError, SetNullNotNullableError } from "./errors.js";

// SqlType helpers (rarely needed but useful for advanced consumers)
export { isWidening, sqlTypeEquals } from "./sql-type.js";

// Types
export type { SqlType } from "./sql-type.js";
export type {
  SchemaSnapshot, SnapshotMeta,
  TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor, ColumnDefault,
  ViewDescriptor, FkAction,
  Change, ChangeKind, ChangeStatus,
  AllowOptions, AmbiguousChange, AmbiguousResolution, AmbiguousCallback,
  DiffResult, EmitResult, Dialect,
} from "./types.js";
export type { DiffArgs } from "./diff/index.js";
export type { EmitOptions } from "./emit/index.js";
export type { WriteMigrationOptions, WriteMigrationResult } from "./write-migration.js";

// View diff + dialect emitters
export { classifyViewDiff } from "./view-diff.js";
export type { ViewShape, ViewDiffClass, ViewMigrationOpts } from "./view-diff.js";
export { emitPostgresViewMigration } from "./view-ddl-postgres.js";
export { emitSqliteViewMigration } from "./view-ddl-sqlite.js";

// D1 dialect emitter + safety pass.
// renderD1 is exported directly (unlike renderSqlite/renderPostgres) so
// consumers writing raw wrangler batch scripts can apply the safety pass
// independently without going through emit().
export { renderD1 } from "./emit/d1.js";
export { applyD1SafetyPass, D1UnsupportedStatementError } from "./emit/d1-safety-pass.js";

// View migrations orchestrator
export {
  computeViewMigrations,
  type ViewMigrationInput,
  type ViewMigrationsOpts,
  type ViewMigrationsResult,
} from "./source-aware-diff.js";
