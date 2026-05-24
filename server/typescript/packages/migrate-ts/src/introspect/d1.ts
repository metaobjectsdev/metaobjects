import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, ColumnDefault, SnapshotMeta,
  IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

/**
 * Runner contract: takes a SQL command string and returns wrangler's raw
 * JSON envelope stdout. The CLI wires this to a real exec; tests pass a mock.
 * The runner is responsible for ALL transport concerns (local vs remote,
 * config path, error mapping). introspectD1 only knows about SQL queries.
 */
export type D1Runner = (sql: string) => Promise<string>;

export interface IntrospectD1Options {
  runner: D1Runner;
  binding: string;
  remote: boolean;
  configPath: string | undefined;
}

export async function introspectD1(opts: IntrospectD1Options): Promise<SchemaSnapshot> {
  const exec = async (sql: string): Promise<Record<string, unknown>[]> => {
    const stdout = await opts.runner(sql);
    return parseEnvelope(stdout);
  };

  const versionRows = await exec("SELECT sqlite_version() AS v");
  const meta: SnapshotMeta = {
    sqliteVersion: String(versionRows[0]?.v ?? "0.0.0"),
  };

  const tableRows = await exec(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__new_%' ORDER BY name",
  );

  const tables: TableDescriptor[] = [];
  for (const t of tableRows) {
    const name = String(t.name);
    const createSql = String(t.sql ?? "");
    const cols = await readColumns(exec, name);
    const pk = await readPrimaryKey(exec, name);
    const hasAutoincrement = createSql.toUpperCase().includes("AUTOINCREMENT");
    if (hasAutoincrement && pk.length === 1) {
      const pkCol = cols.find((c) => c.name === pk[0]);
      if (pkCol) pkCol.identity = "increment";
    }
    tables.push({
      name,
      columns: cols,
      indexes: await readIndexes(exec, name),
      foreignKeys: await readForeignKeys(exec, name),
      primaryKey: pk,
    });
  }

  const views = await readViews(exec);
  return { tables, views, meta };
}

function parseEnvelope(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`failed to parse wrangler JSON output: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`unexpected wrangler output shape (expected non-empty array envelope): ${stdout.slice(0, 200)}`);
  }
  const envelope = parsed[0];
  if (envelope === null || typeof envelope !== "object") {
    throw new Error(`unexpected wrangler output shape (envelope is not an object): ${stdout.slice(0, 200)}`);
  }
  const env = envelope as { success?: boolean; error?: string; results?: unknown };
  if (env.success === false) {
    throw new Error(`wrangler d1 execute failed: ${env.error ?? "(no error message)"}`);
  }
  const results = env.results;
  if (!Array.isArray(results)) return [];
  return results as Record<string, unknown>[];
}

async function readColumns(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<ColumnDescriptor[]> {
  const rows = await exec(`SELECT * FROM pragma_table_info('${table}') ORDER BY cid`);
  return rows.map((r) => {
    const col: ColumnDescriptor = {
      name: String(r.name),
      sqlType: sqliteTypeToSqlType(String(r.type)),
      nullable: Number(r.notnull) === 0 && Number(r.pk) === 0,
    };
    const def = parseSqliteDefault(r.dflt_value === null ? null : String(r.dflt_value));
    if (def) col.default = def;
    return col;
  });
}

async function readPrimaryKey(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<string[]> {
  const rows = await exec(`SELECT * FROM pragma_table_info('${table}') ORDER BY cid`);
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

async function readIndexes(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<IndexDescriptor[]> {
  const list = await exec(`SELECT * FROM pragma_index_list('${table}')`);
  const indexes: IndexDescriptor[] = [];
  for (const ix of list) {
    if (String(ix.origin) === "pk") continue;
    if (Number(ix.partial) === 1) continue;
    const ixName = String(ix.name);
    const cols = await exec(`SELECT seqno, cid, name FROM pragma_index_info('${ixName}') ORDER BY seqno`);
    indexes.push({
      name: ixName,
      columns: cols.map((c) => String(c.name)),
      unique: Number(ix.unique) === 1,
    });
  }
  return indexes;
}

async function readForeignKeys(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<FkDescriptor[]> {
  const rows = await exec(`SELECT * FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`);
  const byId = new Map<number, { refTable: string; cols: string[]; refCols: string[]; onDelete: FkAction; onUpdate: FkAction; }>();
  for (const r of rows) {
    const id = Number(r.id);
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        refTable: String(r.table),
        cols: [],
        refCols: [],
        onDelete: sqliteRuleToAction(String(r.on_delete)),
        onUpdate: sqliteRuleToAction(String(r.on_update)),
      };
      byId.set(id, entry);
    }
    entry.cols.push(String(r.from));
    entry.refCols.push(String(r.to));
  }
  return Array.from(byId.entries()).map(([_id, v]) => {
    const fk: FkDescriptor = {
      name: `${table}_${v.cols.join("_")}_fk`,
      columns: v.cols,
      refTable: v.refTable,
      refColumns: v.refCols,
    };
    if (v.onDelete !== "no-action") fk.onDelete = v.onDelete;
    if (v.onUpdate !== "no-action") fk.onUpdate = v.onUpdate;
    return fk;
  });
}

async function readViews(exec: (sql: string) => Promise<Record<string, unknown>[]>): Promise<ViewDescriptor[]> {
  const rows = await exec(
    "SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => ({ name: String(r.name) }));
}

const SQLITE_EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(.*\)/,
];

function parseSqliteDefault(raw: string | null): ColumnDefault | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const isExpr = SQLITE_EXPR_DEFAULT_PATTERNS.some((re) => re.test(raw));
  if (isExpr) return { kind: "expr", value: raw };
  const cleaned = raw.replace(/^'(.*)'$/, "$1");
  return { kind: "literal", value: cleaned };
}

function sqliteTypeToSqlType(declaredType: string): SqlType {
  const t = declaredType.trim().toUpperCase();
  const varcharMatch = /^(?:VARCHAR|CHAR|CHARACTER|TEXT)\((\d+)\)$/.exec(t);
  if (varcharMatch) return { kind: "text", maxLength: parseInt(varcharMatch[1] ?? "0", 10) };
  if (/TEXT|CLOB|VARCHAR|CHAR/.test(t)) return { kind: "text" };
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
  if (t === "INT" || t === "SMALLINT" || t === "TINYINT") return { kind: "integer", bits: 32 };
  if (/INT/.test(t)) return { kind: "integer", bits: 64 };
  if (/REAL|FLOA|DOUB/.test(t)) return { kind: "real" };
  if (t === "BLOB" || t === "") return { kind: "blob" };
  if (/NUMERIC|DECIMAL/.test(t)) return { kind: "numeric" };
  if (t === "JSON") return { kind: "json" };
  return { kind: "text" };
}

function sqliteRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}
