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
  columns: ColumnDescriptor[];
  indexes: IndexDescriptor[];
  foreignKeys: FkDescriptor[];
  primaryKey: string[];              // column names; [] if none
}

export interface ColumnDescriptor {
  name: string;
  sqlType: SqlType;
  nullable: boolean;
  default?: ColumnDefault;
  identity?: "increment" | "uuid";
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
  // structural fields deferred to v0.3
}

// ---------------------------------------------------------------------------
// Change union — produced by diff(), consumed by emit().
// ---------------------------------------------------------------------------

export type Change =
  | { kind: "create-table"; table: TableDescriptor; status: ChangeStatus }
  | { kind: "drop-table"; table: string; status: ChangeStatus }
  | { kind: "rename-table"; from: string; to: string; status: ChangeStatus }
  | { kind: "add-column"; table: string; column: ColumnDescriptor; status: ChangeStatus }
  | { kind: "drop-column"; table: string; column: string; status: ChangeStatus }
  | { kind: "rename-column"; table: string; from: string; to: string; status: ChangeStatus }
  | { kind: "change-column-type"; table: string; column: string;
      from: SqlType; to: SqlType; status: ChangeStatus }
  | { kind: "change-column-nullable"; table: string; column: string;
      from: boolean; to: boolean; status: ChangeStatus }
  | { kind: "change-column-default"; table: string; column: string;
      from?: ColumnDefault; to?: ColumnDefault; status: ChangeStatus }
  | { kind: "add-index"; table: string; index: IndexDescriptor; status: ChangeStatus }
  | { kind: "drop-index"; table: string; index: string; status: ChangeStatus }
  | { kind: "add-fk"; table: string; fk: FkDescriptor; status: ChangeStatus }
  | { kind: "drop-fk"; table: string; fk: string; status: ChangeStatus }
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
