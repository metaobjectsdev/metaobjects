import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  Change, ChangeStatus, DiffResult, AllowOptions, AmbiguousCallback,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { sqlTypeEquals } from "../sql-type.js";
import { applyStatus } from "./status.js";
import { detectColumnRenames, detectTableRenames } from "./rename-heuristic.js";

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
  return (table.schema ?? "public") + "." + table.name;
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
  // Key tables on (schema, name) identity — same table name in different schemas
  // are distinct entities. tableIdentity normalizes undefined → "public".
  const expectedTables = new Map(
    args.expected.tables
      .filter((t) => !shouldIgnoreTable(t.name, ignorePatterns))
      .map((t) => [tableIdentity(t), t] as const),
  );
  const actualTables = new Map(
    args.actual.tables
      .filter((t) => !shouldIgnoreTable(t.name, ignorePatterns))
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
    }
  }
  // Pass 1b: tables present in actual but not expected → drop-table
  // Attach _columns side-channel so detectTableRenames can compare column sets.
  for (const [id, t] of actualTables) {
    if (!expectedTables.has(id)) {
      const dropChange: Change & { _columns?: ColumnDescriptor[] } = {
        kind: "drop-table", table: t.name, ...schemaSpread(t.schema), status: ALLOWED,
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
  }

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
        kind: "drop-column", table, ...sx, column: name, status: ALLOWED,
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
      changes.push({ kind: "drop-index", table, ...sx, index: name, status: ALLOWED });
      changes.push({ kind: "add-index", table, ...sx, index: ix, status: ALLOWED });
    }
  }
  for (const [name] of actualIdx) {
    if (!expectedIdx.has(name)) {
      changes.push({ kind: "drop-index", table, ...sx, index: name, status: ALLOWED });
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
      changes.push({ kind: "drop-fk", table, ...sx, fk: name, status: ALLOWED });
      changes.push({ kind: "add-fk", table, ...sx, fk, status: ALLOWED });
    }
  }
  for (const [name] of actualFk) {
    if (!expectedFk.has(name)) {
      changes.push({ kind: "drop-fk", table, ...sx, fk: name, status: ALLOWED });
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
  return a.columns.every((c, i) => c === b.columns[i]);
}

function fkEquals(a: FkDescriptor, b: FkDescriptor): boolean {
  if (a.refTable !== b.refTable) return false;
  if (a.onDelete !== b.onDelete || a.onUpdate !== b.onUpdate) return false;
  if (a.columns.length !== b.columns.length || a.refColumns.length !== b.refColumns.length) return false;
  return a.columns.every((c, i) => c === b.columns[i])
      && a.refColumns.every((c, i) => c === b.refColumns[i]);
}
