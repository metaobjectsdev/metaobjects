import type { SqlType } from "./sql-type.js";

// ---------------------------------------------------------------------------
// Snapshot descriptors — same shape for expected (from metadata) and actual
// (from introspection). diff() compares two SchemaSnapshots symmetrically.
// ---------------------------------------------------------------------------

export interface SchemaSnapshot {
  tables: TableDescriptor[];
  /** Always empty in v0.1; populated by introspect for v0.3 future-proofing. */
  views: ViewDescriptor[];
  /**
   * Dialect-specific metadata captured at introspect time. Used by emit
   * (e.g., SQLite version → choose native ALTER vs recreate-and-copy fallback).
   */
  meta?: SnapshotMeta;
}

export interface SnapshotMeta {
  sqliteVersion?: string;            // e.g., "3.44.2"; only set for SQLite snapshots
}

export interface TableDescriptor {
  name: string;                      // resolved db name (snake_case, plural)
  /**
   * DB schema this table lives in. Undefined for SQLite (no schema concept).
   * For Postgres, undefined is normalized to "public" at SnapshotMeta boundaries;
   * the diff and emit layers treat undefined === "public" as equivalent.
   */
  schema?: string;
  columns: ColumnDescriptor[];
  indexes: IndexDescriptor[];
  foreignKeys: FkDescriptor[];
  primaryKey: string[];              // column names; [] if none
  /**
   * Human-readable description threaded from entity `@description`.
   * Postgres: emitted as `COMMENT ON TABLE … IS '…';` after CREATE TABLE.
   * SQLite: silently ignored (no native COMMENT support).
   * Introspect side: not read back in v1 (no change-description variant yet).
   */
  description?: string;
}

export interface ColumnDescriptor {
  name: string;
  sqlType: SqlType;
  nullable: boolean;
  default?: ColumnDefault;
  identity?: "increment" | "uuid";
  /**
   * Human-readable description threaded from field `@description`.
   * Postgres: emitted as `COMMENT ON COLUMN … IS '…';` after CREATE TABLE or ADD COLUMN.
   * SQLite: silently ignored (no native COMMENT support).
   * Introspect side: not read back in v1 (no change-description variant yet).
   */
  description?: string;
}

export interface ColumnDefault {
  kind: "literal" | "expr";
  value: string;
}

export interface IndexDescriptor {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface FkDescriptor {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
}

export type FkAction = "cascade" | "set-null" | "restrict" | "no-action";

export interface ViewDescriptor {
  name: string;
  /** Same semantics as TableDescriptor.schema. */
  schema?: string;
  // structural fields deferred to v0.3
}

// ---------------------------------------------------------------------------
// Change union — produced by diff(), consumed by emit().
// ---------------------------------------------------------------------------

/**
 * Every variant with a `table: string` (or `table: TableDescriptor`) field also
 * carries an optional `schema?: string`. For the descriptor-bearing variants
 * (create-table, drop-table source is just a name) the schema is redundant with
 * `table.schema` but kept in parallel so the emit layer has a single, uniform
 * place to read schema regardless of variant.
 *
 * For Postgres, undefined is treated as equivalent to "public" by both diff
 * (table identity normalization) and emit (qualified-name suppression).
 * SQLite has no schema concept; the field is always undefined there.
 */
export type Change =
  | { kind: "create-table"; table: TableDescriptor; schema?: string; status: ChangeStatus }
  | { kind: "drop-table"; table: string; schema?: string; status: ChangeStatus }
  | { kind: "rename-table"; from: string; to: string; schema?: string; status: ChangeStatus }
  | { kind: "add-column"; table: string; schema?: string; column: ColumnDescriptor; status: ChangeStatus }
  | { kind: "drop-column"; table: string; schema?: string; column: string; status: ChangeStatus }
  | { kind: "rename-column"; table: string; schema?: string; from: string; to: string; status: ChangeStatus }
  | { kind: "change-column-type"; table: string; schema?: string; column: string;
      from: SqlType; to: SqlType; status: ChangeStatus }
  | { kind: "change-column-nullable"; table: string; schema?: string; column: string;
      from: boolean; to: boolean; status: ChangeStatus }
  | { kind: "change-column-default"; table: string; schema?: string; column: string;
      from?: ColumnDefault; to?: ColumnDefault; status: ChangeStatus }
  | { kind: "add-index"; table: string; schema?: string; index: IndexDescriptor; status: ChangeStatus }
  | { kind: "drop-index"; table: string; schema?: string; index: string; status: ChangeStatus }
  | { kind: "add-fk"; table: string; schema?: string; fk: FkDescriptor; status: ChangeStatus }
  | { kind: "drop-fk"; table: string; schema?: string; fk: string; status: ChangeStatus }
  // Declared for v0.3, never produced in v0.1:
  | { kind: "create-view"; view: ViewDescriptor; status: ChangeStatus }
  | { kind: "drop-view"; view: string; status: ChangeStatus }
  | { kind: "replace-view"; view: ViewDescriptor; status: ChangeStatus };

export type ChangeKind = Change["kind"];

export interface ChangeStatus {
  state: "allowed" | "blocked";
  blockedReason?: string;
}

// ---------------------------------------------------------------------------
// diff() options
// ---------------------------------------------------------------------------

export interface AllowOptions {
  dropColumn?: boolean;
  dropTable?: boolean;
  /** Narrowing/lossy types only; widening always allowed regardless of this flag. */
  typeChange?: boolean;
  dropIndex?: boolean;
  dropFk?: boolean;
  /** Existing data must satisfy NOT NULL; diff cannot verify this. */
  nullableToNotNull?: boolean;
}

export type AmbiguousChange =
  | {
      kind: "possible-column-rename";
      table: string;
      from: { name: string; sqlType: SqlType };
      to: { name: string; sqlType: SqlType };
    }
  | {
      kind: "possible-table-rename";
      from: { name: string; columnCount: number };
      to: { name: string; columnCount: number };
      columnOverlap: number;          // 0..1 fraction
    };

export type AmbiguousResolution = "rename" | "drop+add" | "abort";

export type AmbiguousCallback = (q: AmbiguousChange) => Promise<AmbiguousResolution>;

export interface DiffResult {
  changes: Change[];
  /** Subset of `changes` where status.state === "blocked"; convenience for CLI error messaging. */
  blocked: Change[];
}

// ---------------------------------------------------------------------------
// emit() result
// ---------------------------------------------------------------------------

export interface EmitResult {
  up: string;
  down: string;
  /**
   * Tables rebuilt via the SQLite recreate-and-copy pattern. Empty for
   * postgres (in-place ALTER). The CLI uses this to pre-drop only the
   * views whose source tables are being recreated — SQLite's RENAME re-
   * parses dependent view definitions and errors if any reference the
   * mid-recreate source table.
   */
  recreatedTables: ReadonlySet<string>;
}

export type Dialect = "postgres" | "sqlite";
