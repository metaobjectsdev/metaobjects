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
  checks: CheckDescriptor[];
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
  /**
   * Per-column sort direction, positional to `columns`. Omitted (or "asc") = the
   * default ascending order, which Postgres does not render in an index def. A
   * "desc" entry emits `<col> DESC` and is compared against the introspected
   * `pg_index.indoption` DESC bit. Absent ⇒ all-ascending.
   */
  orders?: ("asc" | "desc")[];
  /**
   * Partial-index predicate (raw SQL, e.g. `delivered_at IS NULL`). Emitted as a
   * trailing `WHERE (<predicate>)`; compared against the introspected
   * `pg_get_expr(indpred, …)` after expression normalization. Absent ⇒ full index.
   */
  where?: string;
  /**
   * Raw key EXPRESSION for a functional/expression index (e.g. `lower((email)::text)`).
   * When present, the index key is this expression and `columns` is empty —
   * emitted as `(<expr>)` and compared against the introspected `pg_get_indexdef`
   * key after normalization.
   */
  expr?: string;
  /**
   * Index access method (`gin`, `gist`, `hash`, …). Absent / `btree` is the
   * default and not rendered. Emitted as `USING <method>` before the key list.
   */
  using?: string;
}

export interface CheckDescriptor {
  /** Constraint name, e.g. `<table>_<column>_chk`. Diff/identity key. */
  name: string;
  /** The boolean SQL expression, e.g. `status IN ('OPEN','CLOSED')`. */
  expression: string;
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

/** One output column of a view, in SELECT order. */
export interface ViewColumnDescriptor {
  name: string;
  sqlType: SqlType;
}

/** A relation that depends on a view — i.e. what a `DROP ... CASCADE` would destroy. */
export interface DependentRelation {
  schema: string;
  name: string;
  /** 'v' = view, 'm' = materialized view. */
  relkind: "v" | "m";
  /**
   * True when this dependent is a view MetaObjects manages (it carries our
   * fingerprint). A managed dependent that the same migration recreates is
   * harmless; an UNMANAGED one is somebody else's object and a CASCADE destroys
   * it irrecoverably.
   */
  managed: boolean;
}

export interface ViewDescriptor {
  name: string;
  /** Same semantics as TableDescriptor.schema. */
  schema?: string;
  /**
   * View definition SQL.
   *
   * On the EXPECTED side (`buildExpectedSchema` / `buildExpectedViews`) this is
   * the view body — the SELECT clause through the FROM/WHERE/GROUP-BY tail. It is
   * the input to `viewFingerprint()`.
   *
   * On the ACTUAL side (`introspect`) this is whatever the DB catalog stores.
   * Its role is DIALECT-DEPENDENT, and this is load-bearing:
   *
   *   - SQLite/D1 store `sqlite_master.sql` VERBATIM — the exact text we wrote —
   *     so there the body is a sound basis for comparison (`viewSqlEquals`).
   *
   *   - Postgres does NOT store view SQL. It stores the parse tree, and
   *     `pg_get_viewdef()` DEPARSES it back into Postgres's own canonical style
   *     (lowercased functions, `LEFT OUTER JOIN` → `LEFT JOIN`, parenthesized FROM
   *     items and ON predicates, dropped redundant aliases). It can never equal
   *     what we emitted, so on Postgres the body is NOT used for comparison —
   *     `fingerprint` is. The deparsed body is still carried, as the RESTORE
   *     payload for a down migration (it is valid SQL that reproduces the view).
   */
  sql?: string;
  /**
   * Content hash of the generated body — `metaobjects:v1:sha256:<hex>` — stamped
   * into the view's `COMMENT ON VIEW` at emit time and read back at introspect
   * time. This, not the body text, is how Postgres decides whether a view is
   * up to date (see view-fingerprint.ts).
   *
   * Absent on the actual side means the view carries NO MetaObjects stamp: either
   * it is hand-written, or it predates fingerprinting. The two are
   * indistinguishable on Postgres, so the diff fails CLOSED and blocks pending
   * `allow.adoptView`.
   */
  fingerprint?: string;
  /**
   * The view's output columns, in SELECT order. Drives the replace-vs-drop
   * decision: Postgres permits `CREATE OR REPLACE VIEW` only when the existing
   * columns are a PREFIX of the new ones (same names, same types, same order,
   * additions at the end only). Undefined = unknown → fail safe to drop+create.
   */
  columns?: readonly ViewColumnDescriptor[];
  /**
   * Relations that depend on this view (transitively). Populated on the ACTUAL
   * side by introspection. A `DROP VIEW` with dependents needs CASCADE, which
   * destroys every one of them — including views owned by other applications.
   */
  dependents?: readonly DependentRelation[];
  /**
   * Physical tables this view reads (base + joined tables). Populated on the
   * EXPECTED side only (the view producer knows the join graph; introspection
   * does not resolve it). The diff uses it to drop + recreate the view around a
   * column-altering change to one of its source tables — postgres blocks ALTER on
   * a column a view depends on, and sqlite's recreate-and-copy rebuilds the table.
   */
  dependsOn?: readonly string[];
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
  | { kind: "drop-table"; table: string; schema?: string; restore?: TableDescriptor; status: ChangeStatus }
  | { kind: "rename-table"; from: string; to: string; schema?: string; status: ChangeStatus }
  | { kind: "add-column"; table: string; schema?: string; column: ColumnDescriptor; status: ChangeStatus }
  | { kind: "drop-column"; table: string; schema?: string; column: string; restore?: ColumnDescriptor; status: ChangeStatus }
  | { kind: "rename-column"; table: string; schema?: string; from: string; to: string; status: ChangeStatus }
  | { kind: "change-column-type"; table: string; schema?: string; column: string;
      from: SqlType; to: SqlType; status: ChangeStatus }
  | { kind: "change-column-nullable"; table: string; schema?: string; column: string;
      from: boolean; to: boolean; status: ChangeStatus }
  | { kind: "change-column-default"; table: string; schema?: string; column: string;
      from?: ColumnDefault; to?: ColumnDefault; status: ChangeStatus }
  | { kind: "add-index"; table: string; schema?: string; index: IndexDescriptor; status: ChangeStatus }
  | { kind: "drop-index"; table: string; schema?: string; index: string; restore?: IndexDescriptor; status: ChangeStatus }
  | { kind: "add-fk"; table: string; schema?: string; fk: FkDescriptor; status: ChangeStatus }
  | { kind: "drop-fk"; table: string; schema?: string; fk: string; restore?: FkDescriptor; status: ChangeStatus }
  | { kind: "add-check"; table: string; schema?: string; check: CheckDescriptor; status: ChangeStatus }
  | { kind: "drop-check"; table: string; schema?: string; check: string; restore?: CheckDescriptor; status: ChangeStatus }
  // Declared for v0.3, never produced in v0.1:
  | { kind: "create-view"; view: ViewDescriptor; schema?: string; status: ChangeStatus }
  | {
      kind: "drop-view";
      view: string;
      schema?: string;
      status: ChangeStatus;
      /** The view as it exists in the DB — lets the down migration recreate it. */
      restore?: ViewDescriptor;
      /**
       * Relations a CASCADE would destroy. EXTERNAL dependents only: a managed view
       * this same migration recreates is filtered out (it comes back). Non-empty ⇒
       * a plain DROP VIEW would fail at apply, and CASCADE would destroy objects we
       * do not manage — so this is blocked pending `allow.dropViewCascade`.
       */
      dependents?: readonly DependentRelation[];
    }
  | {
      kind: "replace-view";
      view: ViewDescriptor;
      schema?: string;
      status: ChangeStatus;
      /** The view as it exists in the DB — lets the down migration restore the old body. */
      restore?: ViewDescriptor;
      /**
       * The DB view carries no MetaObjects fingerprint — hand-written, or created
       * before fingerprinting existed. We cannot tell which (Postgres deparses away
       * the text evidence), and overwriting a hand-written view destroys SQL no down
       * migration can recover. Blocked pending `allow.adoptView`.
       */
      unmanagedActual?: boolean;
    };

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
  dropCheck?: boolean;
  /**
   * Gates a REAL view removal (present in the DB, absent from the model) — like
   * every other drop. The internal drop/create recreate pair the diff emits
   * around a column-altering change to a view's source table is NOT gated (the
   * view is re-created in the same migration).
   */
  dropView?: boolean;
  /**
   * Gates `DROP VIEW ... CASCADE`. A view with dependents cannot be dropped plainly
   * (Postgres refuses), and CASCADE destroys every dependent — including views and
   * materialized views owned by OTHER applications, which this tool does not manage
   * and cannot restore. Strictly ADDITIONAL to `dropView`: `--allow drop-view` alone
   * never cascades, and a plain non-cascading DROP VIEW stays the emitted form
   * whenever there are no dependents, so Postgres itself backstops a stale
   * dependents snapshot rather than silently cascading.
   */
  dropViewCascade?: boolean;
  /**
   * Gates overwriting an existing view that carries NO MetaObjects fingerprint —
   * i.e. taking ownership of it. It is either hand-written or predates
   * fingerprinting, and on Postgres those are indistinguishable. Every environment
   * upgrading from an older toolchain needs exactly one `--allow adopt-view` run to
   * stamp its existing views; after that they are fingerprinted and silent.
   */
  adoptView?: boolean;
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

export type Dialect = "postgres" | "sqlite" | "d1";
