import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor,
  TableDescriptor, SchemaSnapshot, SnapshotMeta, ColumnDefault, ViewDescriptor, FkDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

export interface CarryColumns { insertCols: string[]; selectCols: string[]; }

// Stage ordering similar to PG; recreate-and-copy bundles get inserted
// at their first triggering change's position in Task 23.
//
// #255: a constraint/index DROP and its ADD counterpart share the same kind
// but need OPPOSITE ordering relative to column mutation — a drop must run
// BEFORE the column change (the constraint/index must be gone before its
// column is dropped, or the DDL fails on the referenced-column dependency —
// this applies just as much to an index backing a UNIQUE/FK target as it does
// to the FK/CHECK constraint itself), while an add must run AFTER (the column
// it references must already exist). One stage can't satisfy both, so ALL
// drops — drop-fk/drop-check/drop-index — are hoisted ahead of any column
// mutation; their ADD counterparts (add-fk/add-check/add-index) stay at their
// later stages.
//
// Within that "drops" group, drop-fk/drop-check must ALSO run BEFORE
// drop-index — mirrors postgres.ts: an FK depends on the unique/PK index
// backing its target column, so dropping the index first can fail on that
// dependency, one level removed. drop-index gets its own stage (1.5) strictly
// between drop-fk/drop-check/create-table (1) and column mutation (2).
// (drop-fk/drop-check are always recreate-triggering on SQLite — see
// RECREATE_TRIGGERING_KINDS below — so this mainly orders a drop-fk's
// table-recreate ahead of a native drop-column on a DIFFERENT table it once
// referenced; within the SAME table's recreate bundle, tableChanges order
// doesn't affect the emitted recipe. drop-index is NOT recreate-triggering —
// it's a plain `DROP INDEX`, so this ordering directly controls emission
// order among native statements.)
const STAGE_ORDER: Record<Change["kind"], number> = {
  // drop-view runs FIRST (mirrors postgres): a view that depends on a table about
  // to be recreated-and-copied must be dropped before the DROP TABLE / RENAME, or
  // SQLite's rename re-parses the dependent view and can error mid-recreate. The
  // diff's Pass 2c injects exactly this drop(before)/create(after) pair.
  "drop-view": 0,
  // rename-table runs before every other table change (mirrors postgres): changes on a
  // renamed table — including its recreate-and-copy — are keyed by the NEW name.
  "rename-table": 0.5,
  "drop-fk": 1, "drop-check": 1,
  "create-table": 1,
  "drop-index": 1.5,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3,
  "add-index": 4,
  "add-fk": 5,
  "add-check": 5,
  "drop-table": 6,
  // create-view / replace-view run LAST — after every table change the view reads.
  "create-view": 99, "replace-view": 99,
};

const RECREATE_TRIGGERING_KINDS = new Set<Change["kind"]>([
  "change-column-type", "change-column-nullable", "change-column-default",
  "add-fk", "drop-fk",
  // CHECK constraints are create-time-only inline on SQLite (no ALTER … ADD/DROP
  // CONSTRAINT), so any check change — e.g. an evolved `field.enum @values`
  // membership — rebuilds the table with the new inline CHECK.
  "add-check", "drop-check",
]);

export function renderSqlite(
  changes: readonly Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
  /**
   * The schema the migration starts from (introspected, or the offline snapshot). A
   * rebuilt table's down rebuilds it back to its descriptor here; without it the down
   * can only say which changes it cannot reverse.
   */
  actualSchema?: SchemaSnapshot,
): EmitResult {
  const version = parseVersion(actualMeta?.sqliteVersion);
  const SUPPORTS_DROP = compareVersions(version, [3, 35, 0]) >= 0;
  const SUPPORTS_RENAME = compareVersions(version, [3, 25, 0]) >= 0;

  // Decide per-change whether it triggers recreate-and-copy.
  const triggersRecreate = (c: Change): boolean => {
    if (RECREATE_TRIGGERING_KINDS.has(c.kind)) return true;
    if (c.kind === "drop-column" && !SUPPORTS_DROP) return true;
    if (c.kind === "rename-column" && !SUPPORTS_RENAME) return true;
    return false;
  };

  const sorted = [...changes].sort((a, b) => STAGE_ORDER[a.kind] - STAGE_ORDER[b.kind]);

  // Tables being newly created in this batch — FKs are already included in CREATE TABLE DDL,
  // so add-fk / drop-fk against brand-new tables must NOT trigger recreate-and-copy.
  const newlyCreatedTables = new Set<string>();
  for (const c of sorted) {
    if (c.kind === "create-table") newlyCreatedTables.add(c.table.name);
  }

  // Partition: which tables need a recreate?
  const recreateTables = new Set<string>();
  for (const c of sorted) {
    if (triggersRecreate(c)) {
      const t = changeTable(c);
      if (t && !newlyCreatedTables.has(t)) recreateTables.add(t);
    }
  }

  if (recreateTables.size > 0 && !expectedSchema) {
    throw new Error("expectedSchema required for SQLite recreate-and-copy (pass via emit() options)");
  }

  // For each recreate table, gather every change targeting it; render the recipe once.
  // Other changes pass through native rendering.
  const upStmts: string[] = [];
  const downStmts: string[] = [];
  const handledRecreate = new Set<string>();

  for (const c of sorted) {
    const t = changeTable(c);
    if (t && recreateTables.has(t)) {
      if (handledRecreate.has(t)) continue;        // already bundled at first triggering change
      const tableChanges = sorted.filter((x) => changeTable(x) === t);
      const newTable = expectedSchema!.tables.find((tt) => tt.name === t);
      if (!newTable) throw new Error(`expectedSchema missing table "${t}" needed for recreate`);
      const oldTable = previousTableShape(t, sorted, actualSchema);
      const { up, down } = renderRecreate(t, tableChanges, newTable, oldTable);
      upStmts.push(up);
      downStmts.push(down);
      handledRecreate.add(t);
      continue;
    }
    // add-fk / drop-fk targeting a newly-created table: FK is already in CREATE TABLE DDL — skip.
    if ((c.kind === "add-fk" || c.kind === "drop-fk") && t && newlyCreatedTables.has(t)) {
      continue;
    }
    upStmts.push(renderUpNative(c));
    downStmts.push(renderDownNative(c));
  }

  return {
    up: upStmts.join("\n\n"),
    down: [...downStmts].reverse().join("\n\n"),
    recreatedTables: recreateTables,
  };
}

/** The table a change targets, or undefined for view-scoped changes. Exported for the D1 FK-cascade emitter (read-only). */
export function changeTable(c: Change): string | undefined {
  switch (c.kind) {
    case "create-table": return c.table.name;
    case "drop-table":   return c.table;
    case "rename-table": return c.from;             // applies to source table
    case "add-column":
    case "drop-column":
    case "rename-column":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "add-index":
    case "drop-index":
    case "add-fk":
    case "drop-fk":
    case "add-check":
    case "drop-check":
      return c.table;
    default:
      return undefined;
  }
}

/** newTable columns not newly-added, mapped to their old-name SELECT source (for renames). */
export function computeCarryColumns(tableChanges: Change[], newTable: TableDescriptor): CarryColumns {
  const renames = new Map<string, string>();
  for (const c of tableChanges) if (c.kind === "rename-column") renames.set(c.from, c.to);
  const addedNames = new Set<string>();
  for (const c of tableChanges) if (c.kind === "add-column") addedNames.add(c.column.name);
  const renamesReverse = new Map<string, string>();
  for (const [from, to] of renames) renamesReverse.set(to, from);
  const carry = newTable.columns.filter((c) => !addedNames.has(c.name));
  return { insertCols: carry.map((c) => c.name), selectCols: carry.map((c) => renamesReverse.get(c.name) ?? c.name) };
}

/**
 * The shape `table` (keyed by its post-migration name) had BEFORE this migration, from the
 * actual schema — looked up under its old name when the same migration renames it.
 */
function previousTableShape(
  table: string,
  changes: readonly Change[],
  actualSchema: SchemaSnapshot | undefined,
): TableDescriptor | undefined {
  if (actualSchema === undefined) return undefined;
  const renamed = changes.find(
    (c): c is Extract<Change, { kind: "rename-table" }> => c.kind === "rename-table" && c.to === table,
  );
  const oldName = renamed?.from ?? table;
  return actualSchema.tables.find((t) => t.name === oldName);
}

/** The temp-table prefix of the FORWARD rebuild (the new shape being built). */
const NEW_TABLE_PREFIX = "__new_";
/** The temp-table prefix of the REVERSE rebuild (the previous shape being restored). */
const OLD_TABLE_PREFIX = "__old_";

/**
 * The rebuild recipe: build `target` under a temp name, copy the carried rows, drop the
 * live table, rename the temp one into place, recreate its indexes. Used in both
 * directions — the down is the same recipe aimed at the previous shape.
 */
function renderRebuild(
  table: string,
  target: TableDescriptor,
  tempPrefix: string,
  carry: CarryColumns,
): string {
  const tmp = `${tempPrefix}${table}`;
  const lines: string[] = [];
  lines.push("PRAGMA foreign_keys = OFF;");
  lines.push("BEGIN TRANSACTION;");
  lines.push("");
  lines.push(renderCreateTable({ ...target, name: tmp }));
  if (carry.insertCols.length > 0) {
    lines.push(
      `INSERT INTO ${quote(tmp)} (${carry.insertCols.map(quote).join(", ")}) ` +
      `SELECT ${carry.selectCols.map(quote).join(", ")} FROM ${quote(table)};`,
    );
  }
  lines.push(`DROP TABLE ${quote(table)};`);
  lines.push(`ALTER TABLE ${quote(tmp)} RENAME TO ${quote(table)};`);
  for (const ix of target.indexes) lines.push(renderCreateIndex(table, ix));
  lines.push("");
  lines.push("COMMIT;");
  lines.push("PRAGMA foreign_keys = ON;");
  lines.push("PRAGMA foreign_key_check;");
  return lines.join("\n");
}

function renderRecreate(
  table: string,
  tableChanges: Change[],
  newTable: TableDescriptor,
  oldTable: TableDescriptor | undefined,
): { up: string; down: string } {
  const up = renderRebuild(table, newTable, NEW_TABLE_PREFIX, computeCarryColumns(tableChanges, newTable));
  const down = oldTable === undefined
    ? renderUnreversibleRebuildDown(table, tableChanges)
    : renderReverseRebuild(table, tableChanges, newTable, oldTable);
  return { up, down };
}

/**
 * The down of a rebuild: the same recipe aimed at the PREVIOUS shape — its columns, types,
 * nullability, defaults, CHECKs, FKs and indexes — copying every surviving row back under
 * its old column names. What this cannot give back is named in a NOTE above it, with why.
 */
function renderReverseRebuild(
  table: string,
  tableChanges: Change[],
  newTable: TableDescriptor,
  oldTable: TableDescriptor,
): string {
  // Old column name → the column that holds its values now.
  const renamedTo = new Map<string, string>();
  for (const c of tableChanges) if (c.kind === "rename-column") renamedTo.set(c.from, c.to);
  const renamedFrom = new Map([...renamedTo].map(([from, to]) => [to, from]));
  const newByName = new Map(newTable.columns.map((c) => [c.name, c]));

  const insertCols: string[] = [];
  const selectCols: string[] = [];
  const notes: string[] = [];
  const restoredFrom = new Set<string>();
  for (const oc of oldTable.columns) {
    const now = newByName.get(renamedTo.get(oc.name) ?? oc.name);
    if (now === undefined) {
      const failsOnRows = !oc.nullable && oc.default === undefined && oc.identity === undefined;
      notes.push(
        `${quote(oc.name)} was dropped by this migration; its values cannot be restored and the ` +
        `column comes back empty` +
        (failsOnRows ? ` (NOT NULL with no default, so this down fails while ${quote(table)} has rows).` : "."),
      );
      continue;
    }
    restoredFrom.add(now.name);
    insertCols.push(oc.name);
    selectCols.push(now.name);
    if (!oc.nullable && now.nullable) {
      notes.push(
        `${quote(oc.name)} becomes NOT NULL again: a NULL written to ${quote(now.name)} since this ` +
        `migration makes the copy back fail.`,
      );
    }
  }
  for (const nc of newTable.columns) {
    if (!restoredFrom.has(nc.name)) {
      notes.push(`${quote(nc.name)} did not exist before this migration; the down drops it with the values written to it.`);
    }
  }
  // A CHECK carries across the migration when its body is the same once the renamed
  // columns are mapped back (the derived `<table>_<col>_chk` follows its column's rename).
  const toOldNames = (expr: string): string => {
    let out = expr;
    for (const [to, from] of renamedFrom) out = out.split(quote(to)).join(quote(from));
    return out;
  };
  const carriedChecks = new Set(newTable.checks.map((c) => toOldNames(c.expression)));
  for (const chk of oldTable.checks) {
    if (!carriedChecks.has(chk.expression)) {
      notes.push(
        `CHECK ${quote(chk.name)} is restored: a row written since this migration that violates ` +
        `it makes the copy back fail.`,
      );
    }
  }
  const fkKey = (cols: readonly string[], fk: FkDescriptor): string =>
    `${cols.join(",")}->${fk.refTable}(${fk.refColumns.join(",")})`;
  const carriedFks = new Set(
    newTable.foreignKeys.map((fk) => fkKey(fk.columns.map((c) => renamedFrom.get(c) ?? c), fk)),
  );
  for (const fk of oldTable.foreignKeys) {
    if (!carriedFks.has(fkKey(fk.columns, fk))) {
      notes.push(
        `FOREIGN KEY (${fk.columns.map(quote).join(", ")}) to ${quote(fk.refTable)} is restored: a row ` +
        `written since this migration that it rejects fails the foreign_key_check after the copy back.`,
      );
    }
  }

  const header = [`-- Reverses the rebuild of ${quote(table)}: restores its previous shape and copies the rows back.`];
  for (const n of notes) header.push(`-- NOTE: ${n}`);
  const recipe = renderRebuild(table, { ...oldTable, name: table }, OLD_TABLE_PREFIX, { insertCols, selectCols });
  return `${header.join("\n")}\n${recipe}`;
}

/**
 * Without the previous shape (no actual schema reached the emitter) the down cannot be a
 * reverse rebuild. Say so, and name every change it leaves in place — never a generic
 * "best-effort" that reads as if part of it were handled.
 */
function renderUnreversibleRebuildDown(table: string, tableChanges: Change[]): string {
  return [
    `-- WARNING: this down does NOT reverse the rebuild of ${quote(table)}: the table's`,
    `-- pre-migration shape was not available when it was generated. Reverse by hand:`,
    ...tableChanges.map((c) => `--   ${c.kind}${describeChangeTarget(c)}`),
  ].join("\n");
}

function describeChangeTarget(c: Change): string {
  switch (c.kind) {
    case "add-column":    return ` ${quote(c.column.name)}`;
    case "rename-column": return ` ${quote(c.from)} to ${quote(c.to)}`;
    case "drop-column":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default": return ` ${quote(c.column)}`;
    case "add-check":     return ` ${quote(c.check.name)}`;
    case "drop-check":    return ` ${quote(c.check)}`;
    case "add-fk":        return ` ${quote(c.fk.name)}`;
    case "drop-fk":       return ` ${quote(c.fk)}`;
    case "add-index":     return ` ${quote(c.index.name)}`;
    case "drop-index":    return ` ${quote(c.index)}`;
    default:              return "";
  }
}

/**
 * The diff folds name-only constraint/index renames on POSTGRES ONLY (sqlite keys FKs by
 * column set and CHECKs by expression, so it surfaces no name-only pair). A `rename-table`
 * reaching this emitter with carried renames means that branch was bypassed — fail loudly
 * rather than emit `ALTER INDEX … RENAME`, which SQLite cannot parse.
 */
function assertNoCarriedRenames(c: Extract<Change, { kind: "rename-table" | "rename-column" }>): void {
  if (c.constraintRenames !== undefined || c.indexRenames !== undefined) {
    throw new Error(`${c.kind} carries constraintRenames/indexRenames — the sqlite/d1 diff never produces these (postgres-only fold)`);
  }
}

function renderUpNative(c: Change): string {
  switch (c.kind) {
    case "create-table":   return renderCreateTable(c.table);
    // #313 — FORWARD drops are `IF EXISTS` so a committed chain applies to a VIRGIN
    // database: the diff legitimately proposes dropping an object present in the live
    // DB that no migration in the chain ever created. `renderDownNative` stays bare
    // (a no-op rollback would still be recorded as done), and so does the
    // recreate-and-copy rebuild's DROP above — that one drops a table the same recipe
    // just INSERT…SELECTed from, where IF EXISTS turns a caught corruption into a
    // silent one.
    case "drop-table":     return `DROP TABLE IF EXISTS ${quote(c.table)};`;
    case "rename-table": {
      assertNoCarriedRenames(c);
      return `ALTER TABLE ${quote(c.from)} RENAME TO ${quote(c.to)};`;
    }
    case "add-column":     return `ALTER TABLE ${quote(c.table)} ADD COLUMN ${renderColumnInline(c.column)};`;
    case "drop-column":    return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column)};`;
    case "rename-column": {
      assertNoCarriedRenames(c);
      return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.from)} TO ${quote(c.to)};`;
    }
    case "add-index":      return renderCreateIndex(c.table, c.index);
    case "drop-index":     return `DROP INDEX IF EXISTS ${quote(c.index)};`;
    case "add-check":
    case "drop-check":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "add-fk":
    case "drop-fk":
      // These are handled by renderRecreate before reaching renderUpNative
      // (checks are create-time-only inline on SQLite, so a check change is a
      // recreate-triggering kind like the others).
      throw new Error(`renderUpNative: ${c.kind} should have been handled by recreate bundler`);
    // SQLite has no schema namespacing for views and no CREATE OR REPLACE VIEW;
    // a replace is DROP + CREATE. The view body lives in ViewDescriptor.sql.
    case "create-view":   return renderCreateView(c.view);
    case "drop-view":     return `DROP VIEW IF EXISTS ${quote(c.view)};`;
    case "replace-view":  return `DROP VIEW IF EXISTS ${quote(c.view.name)};\n${renderCreateView(c.view)}`;
  }
}

// Exported read-only for the D1 FK-cascade, which recreates dependent views around a
// rebuilt table (#243). SQLite emit behavior is unchanged.
export function renderCreateView(v: ViewDescriptor): string {
  if (v.sql === undefined || v.sql.trim().length === 0) {
    throw new Error(`view "${v.name}" has no sql body — buildExpectedSchema must populate it before emit`);
  }
  return `CREATE VIEW ${quote(v.name)} AS\n${v.sql};`;
}

function renderDownNative(c: Change): string {
  switch (c.kind) {
    case "create-table":   return `DROP TABLE ${quote(c.table.name)};`;
    case "drop-table":     return `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
    case "rename-table": {
      assertNoCarriedRenames(c);
      return `ALTER TABLE ${quote(c.to)} RENAME TO ${quote(c.from)};`;
    }
    case "add-column":     return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column.name)};`;
    case "drop-column":    return `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually`;
    case "rename-column": {
      assertNoCarriedRenames(c);
      return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.to)} TO ${quote(c.from)};`;
    }
    case "add-index":      return `DROP INDEX ${quote(c.index.name)};`;
    case "drop-index":     return `-- WARNING: down migration cannot restore the original index definition`;
    case "add-check":
    case "drop-check":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "add-fk":
    case "drop-fk":
      // These are handled by renderRecreate before reaching renderDownNative
      // (checks are create-time-only inline on SQLite, so a check change is a
      // recreate-triggering kind like the others).
      throw new Error(`renderDownNative: ${c.kind} should have been handled by recreate bundler`);
    case "create-view":   return `DROP VIEW IF EXISTS ${quote(c.view.name)};`;
    // The view as the DB held it (`restore`) is a valid restore payload: a view dropped
    // around a table rebuild must come back on rollback, or the schema is not what it was.
    case "drop-view":
      return c.restore !== undefined && hasViewBody(c.restore)
        ? renderRestoreView(c.restore)
        : `-- WARNING: down migration cannot restore the original view definition`;
    case "replace-view":
      return c.restore !== undefined && hasViewBody(c.restore)
        ? `DROP VIEW IF EXISTS ${quote(c.view.name)};\n${renderRestoreView(c.restore)}`
        : `-- WARNING: down migration cannot restore the original view definition`;
  }
}

function hasViewBody(v: ViewDescriptor): boolean {
  return v.sql !== undefined && v.sql.trim().length > 0;
}

/** SQLite introspection captures the whole `CREATE VIEW … AS …` statement; the expected side a bare body. */
function renderRestoreView(v: ViewDescriptor): string {
  const body = (v.sql ?? "").trim().replace(/;\s*$/, "");
  return /^CREATE\s/i.test(body) ? `${body};` : renderCreateView(v);
}

export function renderCreateTable(t: TableDescriptor): string {
  const compositePk = t.primaryKey.length > 1;
  const colDefs = t.columns.map((c) => {
    const isSinglePk = !compositePk && t.primaryKey[0] === c.name;
    return `  ${renderColumnInline(c, isSinglePk)}`;
  });
  if (compositePk) {
    colDefs.push(`  PRIMARY KEY (${t.primaryKey.map(quote).join(", ")})`);
  }
  for (const fk of t.foreignKeys) {
    const cols = fk.columns.map(quote).join(", ");
    const refCols = fk.refColumns.map(quote).join(", ");
    let clause = `  FOREIGN KEY (${cols}) REFERENCES ${quote(fk.refTable)} (${refCols})`;
    if (fk.onDelete) clause += ` ON DELETE ${renderFkAction(fk.onDelete)}`;
    if (fk.onUpdate) clause += ` ON UPDATE ${renderFkAction(fk.onUpdate)}`;
    colDefs.push(clause);
  }
  // CHECK constraints are inlined into the CREATE TABLE DDL (SQLite supports
  // inline named CHECK) — the sole place SQLite emits a CHECK. A check CHANGE
  // on an existing table (add-check/drop-check from the diff) triggers
  // recreate-and-copy, which lands back here with the updated check list.
  for (const chk of t.checks ?? []) {
    colDefs.push(`  CONSTRAINT ${quote(chk.name)} CHECK (${chk.expression})`);
  }
  return `CREATE TABLE ${quote(t.name)} (\n${colDefs.join(",\n")}\n);`;
}

function renderFkAction(action: "cascade" | "set-null" | "restrict" | "no-action"): string {
  switch (action) {
    case "cascade":   return "CASCADE";
    case "set-null":  return "SET NULL";
    case "restrict":  return "RESTRICT";
    case "no-action": return "NO ACTION";
  }
}

function renderColumnInline(c: ColumnDescriptor, isSinglePk = false): string {
  let s = `${quote(c.name)} ${sqliteType(c.sqlType, c.identity)}`;
  if (isSinglePk) s += " PRIMARY KEY";
  if (c.identity === "increment" && isSinglePk) s += " AUTOINCREMENT";
  s += c.nullable ? "" : " NOT NULL";
  if (c.default !== undefined) {
    s += ` DEFAULT ${renderDefault(c.default, c.sqlType)}`;
  } else if (c.identity === "uuid") {
    // SQLite has no native uuid(); approximate via lower(hex(randomblob(16))).
    s += " DEFAULT (lower(hex(randomblob(16))))";
  }
  return s;
}

export function sqliteType(t: SqlType, identity: ColumnDescriptor["identity"]): string {
  if (identity === "increment") return "INTEGER";
  if (identity === "uuid")      return "TEXT";
  switch (t.kind) {
    case "text":      return t.maxLength !== undefined ? `VARCHAR(${t.maxLength})` : "TEXT";
    // Use INTEGER for 64-bit and INT for 32-bit — SQLite preserves the declared type
    // in pragma_table_info, enabling round-trip fidelity (see introspect/sqlite.ts).
    case "integer":   return t.bits === 64 ? "INTEGER" : "INT";
    case "real":      return "REAL";
    case "real4":     return "REAL";
    case "numeric":   {
      if (t.precision !== undefined && t.scale !== undefined) return `NUMERIC(${t.precision},${t.scale})`;
      return "NUMERIC";
    }
    case "boolean":   return "BOOLEAN";        // SQLite stores as 0/1 but preserves declared type for round-trip
    case "timestamp": return "TIMESTAMP";
    case "date":      return "DATE";
    case "time":      return "TIME";
    case "json":      return "TEXT";          // SQLite has JSON1 but stores as text
    case "blob":      return "BLOB";
    case "uuid":      return "TEXT";
    case "inet":      return "TEXT";          // SQLite has no inet type; store as text
    case "array":     return "TEXT";          // SQLite has no array type; store as JSON text
  }
}

/** A literal safely emittable unquoted on a numeric-affinity column. */
const NUMERIC_LITERAL = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Render a literal default according to the column's declared SQL type.
 *
 * Quoting must NOT be unconditional. SQLite applies the column's affinity when
 * storing a default: a quoted literal that does not *look* numeric (e.g. `'false'`)
 * cannot be coerced under NUMERIC/INTEGER affinity, so it is stored verbatim as
 * TEXT — a mistyped value that a later `col = 0` comparison silently misses.
 * (A numeric-looking `'0'` *is* coerced, which is exactly why this stayed hidden.)
 *
 * SQLite has no boolean literal, so the canonical "true"/"false" become 1/0.
 * Non-numeric junk on a numeric column still falls back to quoting rather than
 * emitting bare invalid SQL — the loader should reject it long before here.
 */
function renderDefault(d: ColumnDefault, t: SqlType): string {
  if (d.kind === "expr") return d.value;
  const quoted = `'${d.value.replace(/'/g, "''")}'`;
  switch (t.kind) {
    case "boolean":
      if (d.value === "true") return "1";
      if (d.value === "false") return "0";
      return NUMERIC_LITERAL.test(d.value) ? d.value : quoted;
    case "integer":
    case "real":
    case "real4":
    case "numeric":
      return NUMERIC_LITERAL.test(d.value) ? d.value : quoted;
    default:
      return quoted;
  }
}

export function renderCreateIndex(table: string, ix: IndexDescriptor): string {
  const u = ix.unique ? "UNIQUE " : "";
  // SQLite natively supports expression indexes, per-column DESC, and partial
  // (WHERE) indexes — render all three. Dropping them is not an option:
  //   - a dropped @expr leaves `();` (invalid SQL — the apply fails outright);
  //   - a dropped @where turns a partial UNIQUE into a FULL unique constraint,
  //     silently rejecting inserts the model says are valid;
  //   - a dropped DESC churns drop/add on every diff once introspection reads
  //     the real ordering back.
  // @using is deliberately NOT rendered: SQLite has exactly one index access
  // method (b-tree) and no USING clause — a plain index is the closest physical
  // realization. The expected snapshot strips `using` for sqlite (Pass 3 in
  // buildExpectedSchema) so the diff stays convergent.
  const keys = ix.expr
    ? ix.expr
    : ix.columns
        .map((c, i) => (ix.orders?.[i] === "desc" ? `${quote(c)} DESC` : quote(c)))
        .join(", ");
  const where = ix.where ? ` WHERE (${ix.where})` : "";
  return `CREATE ${u}INDEX ${quote(ix.name)} ON ${quote(table)} (${keys})${where};`;
}

/** SQLite identifier quoter (`"id"`). Exported for the D1 FK-cascade emitter (read-only). */
export function quote(ident: string): string {
  if (ident.includes('"')) throw new Error(`unsafe identifier: ${ident}`);
  return `"${ident}"`;
}

function parseVersion(v: string | undefined): [number, number, number] {
  if (!v) return [99, 0, 0];           // assume modern when unknown
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [99, 0, 0];
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
