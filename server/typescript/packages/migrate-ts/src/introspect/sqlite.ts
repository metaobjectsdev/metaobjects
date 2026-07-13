import type { Kysely } from "kysely";
import { sql } from "kysely";
import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, SnapshotMeta,
  IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor,
} from "../types.js";
import {
  parseSqliteDefault, sqliteTypeToSqlType, sqliteRuleToAction, parseSqliteChecks,
  buildSqliteIndexDescriptor,
} from "./sqlite-shared.js";
import { MIGRATIONS_TABLE } from "../apply/ledger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawKysely = Kysely<any>;

export async function introspectSqlite(db: Kysely<Record<string, unknown>>): Promise<SchemaSnapshot> {
  const k = db as RawKysely;

  const versionRow = await sql<{ v: string }>`SELECT sqlite_version() AS v`.execute(k);
  const meta: SnapshotMeta = { sqliteVersion: versionRow.rows[0]?.v ?? "0.0.0" };

  // NOTE: "_" is a single-character WILDCARD in SQL LIKE. Unescaped, '__new_%' also
  // matches an ordinary table named "renewals" (verified against real SQLite), silently
  // hiding it from introspection — so the diff re-proposes CREATE TABLE on every run and
  // the next apply dies with "already exists". Escape the underscores.
  const tableNamesRows = await sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      AND name NOT LIKE '\\_\\_new\\_%' ESCAPE '\\'
      AND name <> ${MIGRATIONS_TABLE}
    ORDER BY name
  `.execute(k);

  const tables: TableDescriptor[] = [];
  for (const t of tableNamesRows.rows) {
    const cols = await readSqliteColumns(k, t.name);
    const pk = await readSqlitePrimaryKey(k, t.name);
    // Detect AUTOINCREMENT via the CREATE TABLE statement (sqlite has no PRAGMA for it).
    const hasAutoincrement = (t.sql ?? "").toUpperCase().includes("AUTOINCREMENT");
    if (hasAutoincrement && pk.length === 1) {
      const pkCol = cols.find((c) => c.name === pk[0]);
      if (pkCol) pkCol.identity = "increment";
    }
    tables.push({
      name: t.name,
      columns: cols,
      indexes: await readSqliteIndexes(k, t.name),
      foreignKeys: await readSqliteForeignKeys(k, t.name),
      // Named CHECKs parsed from the stored CREATE TABLE DDL — required for
      // check evolution (enum @values changes) to converge on sqlite.
      checks: parseSqliteChecks(t.sql),
      primaryKey: pk,
    });
  }

  const views = await readSqliteViews(k);
  return { tables, views, meta };
}

async function readSqliteViews(k: RawKysely): Promise<ViewDescriptor[]> {
  // sqlite_master.sql holds the full `CREATE VIEW <name> AS <body>` statement.
  // We carry it through on the descriptor so the diff can detect view-body
  // drift (not just name presence).
  const rows = await sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    ORDER BY name
  `.execute(k);
  return rows.rows.map((r) => {
    const view: ViewDescriptor = { name: r.name };
    if (r.sql) view.sql = r.sql;
    return view;
  });
}

async function readSqliteColumns(k: RawKysely, table: string): Promise<ColumnDescriptor[]> {
  // SELECT * avoids "notnull" being treated as a reserved keyword by libsql.
  const rows = await sql<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>`SELECT * FROM pragma_table_info(${table}) ORDER BY cid`.execute(k);

  return rows.rows.map((r) => {
    const col: ColumnDescriptor = {
      name: r.name,
      sqlType: sqliteTypeToSqlType(r.type),
      nullable: r.notnull === 0 && r.pk === 0,
    };
    const def = parseSqliteDefault(r.dflt_value);
    if (def) col.default = def;
    return col;
  });
}

async function readSqlitePrimaryKey(k: RawKysely, table: string): Promise<string[]> {
  // SELECT * avoids the "notnull" reserved-keyword issue in libsql.
  const rows = await sql<{ name: string; pk: number }>`
    SELECT * FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk
  `.execute(k);
  return rows.rows.map((r) => r.name);
}

async function readSqliteIndexes(k: RawKysely, table: string): Promise<IndexDescriptor[]> {
  // SELECT * avoids "unique" being treated as a reserved keyword by libsql.
  const listRows = await sql<{ seq: number; name: string; unique: number; origin: string; partial: number }>`
    SELECT * FROM pragma_index_list(${table})
  `.execute(k);

  // Stored CREATE INDEX DDL per index — the ONLY catalog for an index's key
  // EXPRESSIONS and partial-index WHERE predicate (no pragma exposes either).
  // Auto-created indexes (column UNIQUE constraints, origin 'u') have sql NULL,
  // which is fine: they can't be partial or expression-keyed.
  const sqlRows = await sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ${table}
  `.execute(k);
  const ddlByName = new Map(sqlRows.rows.map((r) => [r.name, r.sql] as const));

  const indexes: IndexDescriptor[] = [];
  for (const ix of listRows.rows) {
    if (ix.origin === "pk") continue;    // PK index — excluded (lives in TableDescriptor.primaryKey)
    // pragma_index_xinfo (not index_info): includes the DESC bit and marks key
    // columns (key=1) vs auxiliary rowid columns; an expression key has name
    // NULL. SELECT * avoids "desc"/"key" reserved-keyword issues in libsql.
    const xinfo = await sql<{
      seqno: number; cid: number; name: string | null; desc: number; coll: string; key: number;
    }>`
      SELECT * FROM pragma_index_xinfo(${ix.name}) ORDER BY seqno
    `.execute(k);
    indexes.push(buildSqliteIndexDescriptor(
      { name: ix.name, unique: ix.unique === 1, partial: ix.partial === 1 },
      xinfo.rows
        .filter((c) => c.key === 1)
        .map((c) => ({ name: c.name, desc: c.desc === 1 })),
      ddlByName.get(ix.name) ?? null,
    ));
  }
  return indexes;
}

async function readSqliteForeignKeys(k: RawKysely, table: string): Promise<FkDescriptor[]> {
  // SELECT * avoids reserved-word column names ("table", "from", "to", "match") in libsql.
  const rows = await sql<{
    id: number; seq: number; table: string; from: string; to: string;
    on_update: string; on_delete: string; match: string;
  }>`
    SELECT * FROM pragma_foreign_key_list(${table}) ORDER BY id, seq
  `.execute(k);

  const byId = new Map<number, {
    refTable: string; cols: string[]; refCols: string[];
    onDelete: FkAction; onUpdate: FkAction;
  }>();
  for (const r of rows.rows) {
    let entry = byId.get(r.id);
    if (!entry) {
      entry = {
        refTable: r.table,
        cols: [],
        refCols: [],
        onDelete: sqliteRuleToAction(r.on_delete),
        onUpdate: sqliteRuleToAction(r.on_update),
      };
      byId.set(r.id, entry);
    }
    entry.cols.push(r.from);
    entry.refCols.push(r.to);
  }

  return Array.from(byId.entries()).map(([_id, v]) => {
    const fk: FkDescriptor = {
      name: `${table}_${v.cols.join("_")}_fk`,  // SQLite has no FK name; synthesize to match expected-schema convention
      columns: v.cols,
      refTable: v.refTable,
      refColumns: v.refCols,
    };
    if (v.onDelete !== "no-action") fk.onDelete = v.onDelete;
    if (v.onUpdate !== "no-action") fk.onUpdate = v.onUpdate;
    return fk;
  });
}

