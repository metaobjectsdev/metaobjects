import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor,
  TableDescriptor, SchemaSnapshot, SnapshotMeta, ColumnDefault,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

// Stage ordering similar to PG; recreate-and-copy bundles get inserted
// at their first triggering change's position in Task 23.
const STAGE_ORDER: Record<Change["kind"], number> = {
  "create-table": 1,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3, "rename-table": 3,
  "add-index": 4, "drop-index": 4,
  "add-fk": 5, "drop-fk": 5,
  "drop-table": 6,
  "create-view": 99, "drop-view": 99, "replace-view": 99,
};

const RECREATE_TRIGGERING_KINDS = new Set<Change["kind"]>([
  "change-column-type", "change-column-nullable", "change-column-default",
  "add-fk", "drop-fk",
]);

export function renderSqlite(
  changes: readonly Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
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
      const { up, down } = renderRecreate(t, tableChanges, newTable);
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

function changeTable(c: Change): string | undefined {
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
      return c.table;
    default:
      return undefined;
  }
}

function renderRecreate(
  table: string,
  tableChanges: Change[],
  newTable: TableDescriptor,
): { up: string; down: string } {
  // Build the column-name remapping: old_name → new_name (for renames).
  const renames = new Map<string, string>();
  for (const c of tableChanges) {
    if (c.kind === "rename-column") renames.set(c.from, c.to);
  }

  // Columns added in this migration don't exist in old table — exclude from SELECT.
  const addedNames = new Set<string>();
  for (const c of tableChanges) {
    if (c.kind === "add-column") addedNames.add(c.column.name);
  }

  // Reverse map: new_name → old_name (for SELECT source column lookup).
  const renamesReverse = new Map<string, string>();
  for (const [from, to] of renames) renamesReverse.set(to, from);

  // carryColumns = newTable columns NOT being newly added (they exist in the old table).
  const carryColumns = newTable.columns.filter((c) => !addedNames.has(c.name));
  const insertCols = carryColumns.map((c) => c.name);
  const selectCols = carryColumns.map((c) => renamesReverse.get(c.name) ?? c.name);

  // Build the new-table CREATE using temp name.
  const tmp = `__new_${table}`;
  const tmpDescriptor: TableDescriptor = { ...newTable, name: tmp };
  const createNew = renderCreateTable(tmpDescriptor);
  const indexes = newTable.indexes;     // recreated post-rename

  const lines: string[] = [];
  lines.push("PRAGMA foreign_keys = OFF;");
  lines.push("BEGIN TRANSACTION;");
  lines.push("");
  lines.push(createNew);
  if (insertCols.length > 0) {
    lines.push(
      `INSERT INTO ${quote(tmp)} (${insertCols.map(quote).join(", ")}) ` +
      `SELECT ${selectCols.map(quote).join(", ")} FROM ${quote(table)};`,
    );
  }
  lines.push(`DROP TABLE ${quote(table)};`);
  lines.push(`ALTER TABLE ${quote(tmp)} RENAME TO ${quote(table)};`);
  for (const ix of indexes) lines.push(renderCreateIndex(table, ix));
  lines.push("");
  lines.push("COMMIT;");
  lines.push("PRAGMA foreign_keys = ON;");
  lines.push("PRAGMA foreign_key_check;");

  // Down: best-effort. Without the actual snapshot we can't perfectly restore,
  // so emit a WARNING comment block.
  const down = [
    `-- WARNING: SQLite recreate-and-copy down migration is best-effort.`,
    `-- Reverse the column type/nullable/default changes by hand if needed.`,
    `-- Dropped data cannot be restored.`,
  ].join("\n");

  return { up: lines.join("\n"), down };
}

function renderUpNative(c: Change): string {
  switch (c.kind) {
    case "create-table":   return renderCreateTable(c.table);
    case "drop-table":     return `DROP TABLE ${quote(c.table)};`;
    case "rename-table":   return `ALTER TABLE ${quote(c.from)} RENAME TO ${quote(c.to)};`;
    case "add-column":     return `ALTER TABLE ${quote(c.table)} ADD COLUMN ${renderColumnInline(c.column)};`;
    case "drop-column":    return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column)};`;
    case "rename-column":  return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.from)} TO ${quote(c.to)};`;
    case "add-index":      return renderCreateIndex(c.table, c.index);
    case "drop-index":     return `DROP INDEX ${quote(c.index)};`;
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "add-fk":
    case "drop-fk":
      // These are handled by renderRecreate before reaching renderUpNative.
      throw new Error(`renderUpNative: ${c.kind} should have been handled by recreate bundler`);
    case "create-view":
    case "drop-view":
    case "replace-view":
      throw new Error(`unexpected view-kind in renderSqlite: ${c.kind}`);
  }
}

function renderDownNative(c: Change): string {
  switch (c.kind) {
    case "create-table":   return `DROP TABLE ${quote(c.table.name)};`;
    case "drop-table":     return `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
    case "rename-table":   return `ALTER TABLE ${quote(c.to)} RENAME TO ${quote(c.from)};`;
    case "add-column":     return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column.name)};`;
    case "drop-column":    return `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually`;
    case "rename-column":  return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.to)} TO ${quote(c.from)};`;
    case "add-index":      return `DROP INDEX ${quote(c.index.name)};`;
    case "drop-index":     return `-- WARNING: down migration cannot restore the original index definition`;
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "add-fk":
    case "drop-fk":
      // These are handled by renderRecreate before reaching renderDownNative.
      throw new Error(`renderDownNative: ${c.kind} should have been handled by recreate bundler`);
    case "create-view":
    case "drop-view":
    case "replace-view":
      throw new Error(`unexpected view-kind in renderSqlite: ${c.kind}`);
  }
}

function renderCreateTable(t: TableDescriptor): string {
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
    s += ` DEFAULT ${renderDefault(c.default)}`;
  } else if (c.identity === "uuid") {
    // SQLite has no native uuid(); approximate via lower(hex(randomblob(16))).
    s += " DEFAULT (lower(hex(randomblob(16))))";
  }
  return s;
}

function sqliteType(t: SqlType, identity: ColumnDescriptor["identity"]): string {
  if (identity === "increment") return "INTEGER";
  if (identity === "uuid")      return "TEXT";
  switch (t.kind) {
    case "text":      return t.maxLength !== undefined ? `VARCHAR(${t.maxLength})` : "TEXT";
    // Use INTEGER for 64-bit and INT for 32-bit — SQLite preserves the declared type
    // in pragma_table_info, enabling round-trip fidelity (see introspect/sqlite.ts).
    case "integer":   return t.bits === 64 ? "INTEGER" : "INT";
    case "real":      return "REAL";
    case "numeric":   {
      if (t.precision !== undefined && t.scale !== undefined) return `NUMERIC(${t.precision},${t.scale})`;
      return "NUMERIC";
    }
    case "boolean":   return "BOOLEAN";        // SQLite stores as 0/1 but preserves declared type for round-trip
    case "timestamp": return "TIMESTAMP";
    case "date":      return "DATE";
    case "json":      return "TEXT";          // SQLite has JSON1 but stores as text
    case "blob":      return "BLOB";
    case "uuid":      return "TEXT";
  }
}

function renderDefault(d: ColumnDefault): string {
  if (d.kind === "expr") return d.value;
  return `'${d.value.replace(/'/g, "''")}'`;
}

function renderCreateIndex(table: string, ix: IndexDescriptor): string {
  const u = ix.unique ? "UNIQUE " : "";
  return `CREATE ${u}INDEX ${quote(ix.name)} ON ${quote(table)} (${ix.columns.map(quote).join(", ")});`;
}

function quote(ident: string): string {
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
