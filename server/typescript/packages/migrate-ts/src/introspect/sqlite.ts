import type { Kysely } from "kysely";
import { sql } from "kysely";
import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, ColumnDefault, SnapshotMeta,
  IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawKysely = Kysely<any>;

export async function introspectSqlite(db: Kysely<Record<string, unknown>>): Promise<SchemaSnapshot> {
  const k = db as RawKysely;

  const versionRow = await sql<{ v: string }>`SELECT sqlite_version() AS v`.execute(k);
  const meta: SnapshotMeta = { sqliteVersion: versionRow.rows[0]?.v ?? "0.0.0" };

  const tableNamesRows = await sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__new_%'
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
      primaryKey: pk,
    });
  }

  const views = await readSqliteViews(k);
  return { tables, views, meta };
}

async function readSqliteViews(k: RawKysely): Promise<ViewDescriptor[]> {
  const rows = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `.execute(k);
  return rows.rows.map((r) => ({ name: r.name }));
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

function sqliteTypeToSqlType(declaredType: string): SqlType {
  const t = declaredType.trim().toUpperCase();

  // SQLite's type affinity is loose; we honor the declared type literally for round-trip stability.
  // Affinity rules per sqlite.org/datatype3.html — adapted to canonical SqlType.

  // text affinity
  const varcharMatch = /^(?:VARCHAR|CHAR|CHARACTER|TEXT)\((\d+)\)$/.exec(t);
  if (varcharMatch) return { kind: "text", maxLength: parseInt(varcharMatch[1] ?? "0", 10) };
  if (/TEXT|CLOB|VARCHAR|CHAR/.test(t)) return { kind: "text" };

  // numeric affinity
  const numMatch = /^(?:NUMERIC|DECIMAL)\((\d+)(?:,\s*(\d+))?\)$/.exec(t);
  if (numMatch) {
    const out: SqlType = { kind: "numeric" };
    if (numMatch[1]) out.precision = parseInt(numMatch[1], 10);
    if (numMatch[2]) out.scale = parseInt(numMatch[2], 10);
    return out;
  }
  if (t === "BOOLEAN" || t === "BOOL") return { kind: "boolean" };
  if (t === "DATE") return { kind: "date" };
  if (t === "DATETIME" || t === "TIMESTAMP") return { kind: "timestamp", withTimezone: false };

  // integer affinity (SQLite stores all INTEGER as 64-bit internally).
  // Distinguish INT (32-bit) from INTEGER/BIGINT (64-bit) for round-trip fidelity:
  // the emitter uses "INT" for integer{32} and "INTEGER" for integer{64}.
  if (t === "INT" || t === "SMALLINT" || t === "TINYINT") return { kind: "integer", bits: 32 };
  if (/INT/.test(t)) return { kind: "integer", bits: 64 };

  // real affinity
  if (/REAL|FLOA|DOUB/.test(t)) return { kind: "real" };

  // blob affinity
  if (t === "BLOB" || t === "") return { kind: "blob" };

  // numeric affinity fallback
  if (/NUMERIC|DECIMAL/.test(t)) return { kind: "numeric" };

  // json (libsql/sqlite have JSON1)
  if (t === "JSON") return { kind: "json" };

  return { kind: "text" };
}

const SQLITE_EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(.*\)/,                           // anything function-like
];

function parseSqliteDefault(raw: string | null): ColumnDefault | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const isExpr = SQLITE_EXPR_DEFAULT_PATTERNS.some((re) => re.test(raw));
  if (isExpr) return { kind: "expr", value: raw };
  // SQLite stores literal string defaults with surrounding quotes.
  const cleaned = raw.replace(/^'(.*)'$/, "$1");
  return { kind: "literal", value: cleaned };
}

async function readSqliteIndexes(k: RawKysely, table: string): Promise<IndexDescriptor[]> {
  // SELECT * avoids "unique" being treated as a reserved keyword by libsql.
  const listRows = await sql<{ seq: number; name: string; unique: number; origin: string; partial: number }>`
    SELECT * FROM pragma_index_list(${table})
  `.execute(k);

  const indexes: IndexDescriptor[] = [];
  for (const ix of listRows.rows) {
    if (ix.origin === "pk") continue;    // PK index — excluded (lives in TableDescriptor.primaryKey)
    if (ix.partial === 1) continue;      // partial indexes deferred to v0.3
    const cols = await sql<{ seqno: number; cid: number; name: string }>`
      SELECT seqno, cid, name FROM pragma_index_info(${ix.name}) ORDER BY seqno
    `.execute(k);
    indexes.push({
      name: ix.name,
      columns: cols.rows.map((c) => c.name),
      unique: ix.unique === 1,
    });
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

function sqliteRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}
