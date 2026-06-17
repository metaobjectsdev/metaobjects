import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  ViewDescriptor,
  Change, ChangeStatus, DiffResult, AllowOptions, AmbiguousCallback, Dialect,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { sqlTypeEquals } from "../sql-type.js";
import { applyStatus } from "./status.js";
import { detectColumnRenames, detectTableRenames } from "./rename-heuristic.js";
import { viewSqlEquals } from "../view-sql-compare.js";
import { checkExprEquals, normalizeCheckExpr } from "../check-expr-compare.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";

export interface DiffArgs {
  expected: SchemaSnapshot;
  actual: SchemaSnapshot;
  allow?: AllowOptions;
  onAmbiguous?: AmbiguousCallback;
  /**
   * Table-name patterns to ignore on both sides of the diff. Tables matching
   * any pattern are excluded from comparison — neither create-table nor
   * drop-table changes are emitted for them, and they're omitted from index/
   * fk passes. Supports exact names and `*` glob wildcards.
   *
   * Defaults to [`__drizzle_migrations`] when omitted so the Drizzle migration-
   * tracking table doesn't surface as a drop. Pass `[]` explicitly to disable
   * the default. Pass additional patterns to extend.
   */
  ignoreTables?: string[];
  /**
   * Restrict the diff to a set of DB schemas. A table whose schema is not in this
   * set is excluded from BOTH sides — neither created/altered nor dropped.
   *
   * When omitted, the scope is **auto-derived from the schemas the expected
   * (metadata) side declares**: the model manages only the schemas it actually
   * mentions, so a table living in a schema the model never declares belongs to
   * another owner (e.g. a downstream app's schema sharing the same database) and is
   * left untouched. This makes per-owner drift gates clean without manual config —
   * a model that declares only `public` ignores a co-located downstream-app schema,
   * and vice versa. Pass an explicit set to override; pass nothing for the smart default.
   *
   * Auto-scoping is skipped when the expected side declares no tables at all
   * (nothing to manage → prior whole-DB behavior is preserved).
   */
  scopeSchemas?: string[];
  /** Dialect; CHECK-constraint evolution on existing tables is emitted for postgres only. */
  dialect?: Dialect;
}

const ALLOWED: ChangeStatus = { state: "allowed" };

/**
 * Default ignore-table patterns. Catches migration-tracking and replication
 * sidecar tables that downstream tools (Drizzle, litestream) create automatically.
 */
const DEFAULT_IGNORE_TABLES: string[] = [
  "__drizzle_migrations",
  "_litestream_*",
];

/**
 * Normalize undefined schema to "public" (Postgres default) for comparison purposes.
 * Allows snapshots from buildExpectedSchema (often undefined) to compare equal to
 * snapshots from introspect (always populated for Postgres).
 *
 * For SQLite (no schema concept), every table has schema=undefined, so this maps
 * all tables to the same "public." prefix — harmless and preserves existing behavior.
 */
function tableIdentity(table: { name: string; schema?: string }): string {
  return (table.schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + table.name;
}

/**
 * Build the optional-schema spread used when constructing Change records.
 * Required because `exactOptionalPropertyTypes: true` rejects explicit `undefined`
 * for an optional field — we either include the key or we don't.
 */
function schemaSpread(schema: string | undefined): { schema?: string } {
  return schema !== undefined ? { schema } : {};
}

function tableMatchesPattern(name: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  }
  return name === pattern;
}

function shouldIgnoreTable(name: string, patterns: string[]): boolean {
  return patterns.some((p) => tableMatchesPattern(name, p));
}

/**
 * Compares an expected schema (from metadata) against an actual schema (from introspection)
 * and produces the change list to bring actual → expected. Always returns a Promise.
 *
 * Per spec §6.
 *
 * Accepts either the full DiffArgs object, or positional (expected, actual[, opts]) for
 * convenience in tests and simple callers.
 */
export async function diff(args: DiffArgs): Promise<DiffResult>;
export async function diff(expected: SchemaSnapshot, actual: SchemaSnapshot, opts?: Omit<DiffArgs, "expected" | "actual">): Promise<DiffResult>;
export async function diff(
  argsOrExpected: DiffArgs | SchemaSnapshot,
  actualMaybe?: SchemaSnapshot,
  optsMaybe?: Omit<DiffArgs, "expected" | "actual">,
): Promise<DiffResult> {
  // Normalize args.
  const args: DiffArgs = isDiffArgs(argsOrExpected)
    ? argsOrExpected
    : { expected: argsOrExpected, actual: actualMaybe!, ...(optsMaybe ?? {}) };

  const changes: Change[] = [];

  const ignorePatterns = args.ignoreTables ?? DEFAULT_IGNORE_TABLES;

  // Schema scope (see DiffArgs.scopeSchemas): an explicit set, else the schemas the
  // expected/metadata side declares (the smart default — the model owns only the
  // schemas it mentions), else null = no scoping (empty model → prior whole-DB
  // behavior). A table outside the scope is excluded from both sides, so a
  // co-located schema owned by another app is neither dropped nor reported.
  const declaredSchemas = new Set(
    args.expected.tables.map((t) => t.schema ?? DEFAULT_DB_SCHEMA_POSTGRES),
  );
  const scopeSchemas: Set<string> | null =
    args.scopeSchemas !== undefined
      ? new Set(args.scopeSchemas)
      : declaredSchemas.size > 0
        ? declaredSchemas
        : null;
  const inScope = (schema: string | undefined): boolean =>
    scopeSchemas === null || scopeSchemas.has(schema ?? DEFAULT_DB_SCHEMA_POSTGRES);

  // Key tables on (schema, name) identity — same table name in different schemas
  // are distinct entities. tableIdentity normalizes undefined → "public".
  const expectedTables = new Map(
    args.expected.tables
      .filter((t) => !shouldIgnoreTable(t.name, ignorePatterns) && inScope(t.schema))
      .map((t) => [tableIdentity(t), t] as const),
  );
  const actualTables = new Map(
    args.actual.tables
      .filter((t) => !shouldIgnoreTable(t.name, ignorePatterns) && inScope(t.schema))
      .map((t) => [tableIdentity(t), t] as const),
  );

  // Pass 1: tables present in expected but not actual → create-table + add-index + add-fk
  // Indexes and FKs are separate SQL statements (not part of CREATE TABLE), so they
  // must be emitted as individual changes even for brand-new tables.
  for (const [id, table] of expectedTables) {
    if (!actualTables.has(id)) {
      changes.push({ kind: "create-table", table, ...schemaSpread(table.schema), status: ALLOWED });
      for (const index of table.indexes) {
        changes.push({
          kind: "add-index", table: table.name, ...schemaSpread(table.schema),
          index, status: ALLOWED,
        });
      }
      for (const fk of table.foreignKeys) {
        changes.push({
          kind: "add-fk", table: table.name, ...schemaSpread(table.schema),
          fk, status: ALLOWED,
        });
      }
      // CHECK constraints are inlined into the CREATE TABLE DDL at emit time
      // (both postgres and sqlite support inline CHECK), so they ride on
      // `create-table.table.checks` rather than as separate add-check changes.
      // For brand-new tables no add-check is emitted here; existing-table CHECK
      // evolution (add/drop on tables present on both sides) is handled by
      // diffTableChecks in Pass 2.
    }
  }
  // Pass 1b: tables present in actual but not expected → drop-table
  // Attach _columns side-channel so detectTableRenames can compare column sets.
  for (const [id, t] of actualTables) {
    if (!expectedTables.has(id)) {
      const dropChange: Change & { _columns?: ColumnDescriptor[] } = {
        kind: "drop-table", table: t.name, ...schemaSpread(t.schema), restore: t, status: ALLOWED,
      };
      dropChange._columns = t.columns;
      changes.push(dropChange);
    }
  }

  // Pass 2: tables in both → compare columns/indexes/FKs
  for (const [id, expectedTable] of expectedTables) {
    const actualTable = actualTables.get(id);
    if (!actualTable) continue;
    diffTableColumns(expectedTable, actualTable, changes);
    diffTableIndexes(expectedTable, actualTable, changes);
    diffTableForeignKeys(expectedTable, actualTable, changes);
    // CHECK constraints on existing tables are evolved for postgres only (SQLite
    // evolves checks via table recreate, not ALTER). Gated on `actual.checks`
    // being populated — by the snapshot offline, or pg_constraint introspection.
    if (args.dialect === "postgres") diffTableChecks(expectedTable, actualTable, changes);
  }

  // Pass 2b: views. Identity is (schema, name). A name present on both sides
  // with a divergent body (whitespace-/wrapper-normalized) emits replace-view;
  // introspect now reads the actual body so view-body drift is visible.
  diffViews(
    args.expected.views.filter((v) => inScope(v.schema)),
    args.actual.views.filter((v) => inScope(v.schema)),
    changes,
  );

  // Pass 3: detect table renames BEFORE column renames — so a renamed table's
  // columns are not scanned as orphaned drop/add pairs.
  await detectTableRenames(changes, args.onAmbiguous);
  await detectColumnRenames(changes, args.onAmbiguous);

  // Strip the rename-detection side-channel fields before status assignment / return.
  for (const c of changes) {
    type Aug = Change & { _sqlType?: unknown; _nullable?: unknown; _columns?: unknown };
    delete (c as Aug)._sqlType;
    delete (c as Aug)._nullable;
    delete (c as Aug)._columns;
  }

  applyStatus(changes, args.allow ?? {});
  return { changes, blocked: changes.filter((c) => c.status.state === "blocked") };
}

function isDiffArgs(x: DiffArgs | SchemaSnapshot): x is DiffArgs {
  return "expected" in x && "actual" in x;
}

function diffTableColumns(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const expectedCols = new Map(expected.columns.map((c) => [c.name, c]));
  const actualCols = new Map(actual.columns.map((c) => [c.name, c]));

  for (const [name, ec] of expectedCols) {
    const ac = actualCols.get(name);
    if (!ac) {
      changes.push({ kind: "add-column", table, ...sx, column: ec, status: ALLOWED });
      continue;
    }
    // Compare type, nullable, default — emit per-aspect change.
    if (!sqlTypeEquals(ec.sqlType, ac.sqlType)) {
      changes.push({
        kind: "change-column-type", table, ...sx, column: name,
        from: ac.sqlType, to: ec.sqlType, status: ALLOWED,
      });
    }
    if (ec.nullable !== ac.nullable) {
      changes.push({
        kind: "change-column-nullable", table, ...sx, column: name,
        from: ac.nullable, to: ec.nullable, status: ALLOWED,
      });
    }
    if (!columnDefaultsEqual(ec.default, ac.default)) {
      const change: Change = {
        kind: "change-column-default", table, ...sx, column: name,
        status: ALLOWED,
        ...(ac.default !== undefined ? { from: ac.default } : {}),
        ...(ec.default !== undefined ? { to: ec.default } : {}),
      };
      changes.push(change);
    }
  }
  for (const [name, ac] of actualCols) {
    if (!expectedCols.has(name)) {
      const dropChange: Change & { _sqlType?: SqlType; _nullable?: boolean } = {
        kind: "drop-column", table, ...sx, column: name, restore: ac, status: ALLOWED,
      };
      dropChange._sqlType = ac.sqlType;
      dropChange._nullable = ac.nullable;
      changes.push(dropChange);
    }
  }
}

function diffTableIndexes(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const expectedIdx = new Map(expected.indexes.map((i) => [i.name, i]));
  const actualIdx = new Map(actual.indexes.map((i) => [i.name, i]));
  for (const [name, ix] of expectedIdx) {
    const a = actualIdx.get(name);
    if (!a) {
      changes.push({ kind: "add-index", table, ...sx, index: ix, status: ALLOWED });
    } else if (!indexEquals(ix, a)) {
      // Index shape changed: drop + add (atomic from caller's perspective).
      // restore = the ACTUAL shape so the down re-creates the original index.
      changes.push({ kind: "drop-index", table, ...sx, index: name, restore: a, status: ALLOWED });
      changes.push({ kind: "add-index", table, ...sx, index: ix, status: ALLOWED });
    }
  }
  for (const [name, ai] of actualIdx) {
    if (!expectedIdx.has(name)) {
      changes.push({ kind: "drop-index", table, ...sx, index: name, restore: ai, status: ALLOWED });
    }
  }
}

function diffTableForeignKeys(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const expectedFk = new Map(expected.foreignKeys.map((f) => [f.name, f]));
  const actualFk = new Map(actual.foreignKeys.map((f) => [f.name, f]));
  for (const [name, fk] of expectedFk) {
    const a = actualFk.get(name);
    if (!a) {
      changes.push({ kind: "add-fk", table, ...sx, fk, status: ALLOWED });
    } else if (!fkEquals(fk, a)) {
      // FK shape changed: drop + add. restore = the ACTUAL shape so the down
      // re-creates the original FK.
      changes.push({ kind: "drop-fk", table, ...sx, fk: name, restore: a, status: ALLOWED });
      changes.push({ kind: "add-fk", table, ...sx, fk, status: ALLOWED });
    }
  }
  for (const [name, af] of actualFk) {
    if (!expectedFk.has(name)) {
      changes.push({ kind: "drop-fk", table, ...sx, fk: name, restore: af, status: ALLOWED });
    }
  }
}

function diffTableChecks(expected: TableDescriptor, actual: TableDescriptor, changes: Change[]): void {
  const sx = schemaSpread(expected.schema);
  const expectedChk = new Map(expected.checks.map((c) => [c.name, c]));
  const actualChk = new Map(actual.checks.map((c) => [c.name, c]));
  for (const [name, ec] of expectedChk) {
    const ac = actualChk.get(name);
    if (!ac) {
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    } else if (!checkExprEquals(ec.expression, ac.expression)) {
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, restore: ac, status: ALLOWED });
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    }
  }
  for (const [name, ac] of actualChk) {
    if (!expectedChk.has(name)) {
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, restore: ac, status: ALLOWED });
    }
  }
}

function viewIdentity(v: { name: string; schema?: string }): string {
  return (v.schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + v.name;
}

function diffViews(
  expected: ViewDescriptor[], actual: ViewDescriptor[], changes: Change[],
): void {
  const exp = new Map(expected.map((v) => [viewIdentity(v), v] as const));
  const act = new Map(actual.map((v) => [viewIdentity(v), v] as const));
  for (const [id, v] of exp) {
    const a = act.get(id);
    if (a === undefined) {
      changes.push({ kind: "create-view", view: v, ...schemaSpread(v.schema), status: ALLOWED });
    } else if (
      // Both bodies known and divergent → replace-view. When either body is
      // absent (e.g. expected projection unresolvable, or an introspector that
      // couldn't read the body) we cannot prove a change, so we leave it alone
      // rather than emit a spurious replace.
      v.sql !== undefined && a.sql !== undefined && !viewSqlEquals(v.sql, a.sql)
    ) {
      changes.push({ kind: "replace-view", view: v, ...schemaSpread(v.schema), status: ALLOWED });
    }
  }
  for (const [id, v] of act) {
    if (!exp.has(id)) {
      changes.push({ kind: "drop-view", view: v.name, ...schemaSpread(v.schema), status: ALLOWED });
    }
  }
}

function columnDefaultsEqual(a: ColumnDescriptor["default"], b: ColumnDescriptor["default"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.kind === b.kind && a.value === b.value;
}

function indexEquals(a: IndexDescriptor, b: IndexDescriptor): boolean {
  if (a.unique !== b.unique) return false;
  if (a.columns.length !== b.columns.length) return false;
  if (!a.columns.every((c, i) => c === b.columns[i])) return false;
  // Per-column ordering: an absent `orders` means all-ascending, so compare against
  // a normalized array (default "asc") rather than requiring both to be present.
  const orderAt = (ix: IndexDescriptor, i: number): "asc" | "desc" => ix.orders?.[i] ?? "asc";
  if (a.columns.some((_, i) => orderAt(a, i) !== orderAt(b, i))) return false;
  // Partial-index predicate: normalize (reuse the CHECK-expr canonicalizer — same PG
  // rewrites: casts, parens, whitespace) so an authored predicate compares equal to
  // the introspected `pg_get_expr` form. Both-absent = equal; one-absent = different.
  if ((a.where === undefined) !== (b.where === undefined)) return false;
  if (a.where !== undefined && b.where !== undefined) {
    if (normalizeCheckExpr(a.where) !== normalizeCheckExpr(b.where)) return false;
  }
  return true;
}

function fkEquals(a: FkDescriptor, b: FkDescriptor): boolean {
  if (a.refTable !== b.refTable) return false;
  if (a.onDelete !== b.onDelete || a.onUpdate !== b.onUpdate) return false;
  if (a.columns.length !== b.columns.length || a.refColumns.length !== b.refColumns.length) return false;
  return a.columns.every((c, i) => c === b.columns[i])
      && a.refColumns.every((c, i) => c === b.refColumns[i]);
}
