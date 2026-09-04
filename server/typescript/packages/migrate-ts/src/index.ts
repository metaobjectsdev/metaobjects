// Public API surface for @metaobjectsdev/migrate-ts v0.1.0
//
// Architecture: pure pipeline — buildExpectedSchema(metadata) +
// introspect(db, dialect) → SchemaSnapshot; diff(expected, actual, opts)
// → Change[]; emit(changes, opts) → { up, down }; writeMigration(...)
// writes the pair to disk.
//
// See docs/specs/2026-05-11-v0.2-sp4-migrate-ts-design.md.

// Pipeline functions
export { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "./expected-schema.js";
export type { ExpectedSchemaWithProvenance, SchemaProvenance } from "./expected-schema.js";
export { introspect, introspectPostgres, introspectSqlite } from "./introspect/index.js";
export { diff } from "./diff/index.js";
export { collectUnmanagedNames } from "./unmanaged.js";
// Per-command scope (`migrate.scope`) — see scope.ts for why the suppression is
// two-sided and why the pattern engine stays in @metaobjectsdev/sdk.
export {
  scopeExpectedSchema,
  declaredSchemasOf,
  carryForwardOutOfScope,
  excludeFromSnapshot,
  scopedDiffInputs,
} from "./scope.js";
export type { ObjectScopePredicate, ScopedExpectedSchema, GovernedScope } from "./scope.js";
export { qualifiedDbName } from "./qualified-name.js";
export { computeDrift, computeDriftFromActual, type ComputeDriftOptions, type DriftResult } from "./drift/drift.js";
export { classifyDrift, driftAgainstSnapshot } from "./drift/classify.js";
export type { DriftClassification } from "./drift/classify.js";
export { emit } from "./emit/index.js";
// The dialect SQL type for a snapshot column, delegating to the SAME renderer the
// DDL emitters use — see column-type-sql.ts for why it is not a switch at the call site.
export { columnTypeSql } from "./column-type-sql.js";
export { writeMigration } from "./write-migration.js";
export { writeMigrationD1 } from "./write-migration-d1.js";
export { writeMigrationFlyway } from "./write-migration-flyway.js";

// Reference-snapshot generation (offline, deterministic).
export {
  serializeSnapshot,
  parseSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "./snapshot/serialize.js";
export { snapshotChecksum } from "./snapshot/checksum.js";
export { snapshotPath, readSnapshot, writeSnapshot } from "./snapshot/store.js";
export { planOffline, baselineFromMetadata } from "./snapshot/plan.js";
export type { PlanOfflineArgs, PlanOfflineResult } from "./snapshot/plan.js";

// Errors
export { BlockedChangesError, SetNullNotNullableError, PrimaryKeyChangeError } from "./errors.js";

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
export type { WriteMigrationD1Options, WriteMigrationD1Result } from "./write-migration-d1.js";
export type { WriteMigrationFlywayOptions, WriteMigrationFlywayResult } from "./write-migration-flyway.js";

// View-body comparison — used by the diff to detect body drift (replace-view).
// View DDL itself is produced by the diff + rendered by each dialect's emitter;
// there is no standalone view-migration emitter (the source-aware-diff / view-diff
// / view-ddl-{postgres,sqlite} stack was folded into the schema-diff path).
export { normalizeViewSql, viewSqlEquals } from "./view-sql-compare.js";

// D1 dialect emitter + safety pass.
// renderD1 is exported directly (unlike renderSqlite/renderPostgres) so
// consumers writing raw wrangler batch scripts can apply the safety pass
// independently without going through emit().
export { renderD1 } from "./emit/d1.js";
export { applyD1SafetyPass, D1UnsupportedStatementError } from "./emit/d1-safety-pass.js";
export { findReferencedRebuilds, D1ReferencedTableRebuildError, D1CyclicForeignKeyError } from "./emit/d1-fk-refuse.js";
export type { D1RebuildRefusal } from "./emit/d1-fk-refuse.js";

// D1 introspection
export { introspectD1, type D1Runner, type IntrospectD1Options } from "./introspect/d1.js";

// Migration-history ledger + ordered transactional apply (postgres/sqlite)
export {
  ensureLedger,
  recordApplied,
  deleteApplied,
  appliedNames,
  appliedRecords,
  recordBaseline,
  baselineRecord,
  BASELINE_NAME,
  MIGRATIONS_TABLE,
  DEFAULT_LEDGER_SCHEMA,
  type LedgerRow,
  type LedgerOptions,
  type LedgerDialect,
} from "./apply/ledger.js";
export {
  applyPending,
  rollbackTo,
  type ApplyPendingOptions,
  type ApplyPendingResult,
  type RollbackToOptions,
  type RollbackToResult,
} from "./apply/apply.js";

// Snapshot-integrity: replay migrations and assert == committed snapshot.
export { verifyReplay } from "./verify/replay.js";
export type { VerifyReplayArgs, VerifyReplayResult } from "./verify/replay.js";

// An empty in-process database to replay a committed chain into (#313).
export { openReplayEngine } from "./verify/replay-engine.js";
export type { ReplayEngine } from "./verify/replay-engine.js";

// Wrangler config helpers
export {
  findWranglerConfig,
  parseWranglerConfig,
  resolveD1Binding,
  type D1Binding,
  type WranglerConfig,
} from "./wrangler-config.js";
