import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, SnapshotMeta,
  IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor,
} from "../types.js";
import { parseSqliteDefault, sqliteTypeToSqlType, sqliteRuleToAction } from "./sqlite-shared.js";

/**
 * Runner contract: takes a SQL command string and returns wrangler's raw
 * JSON envelope stdout. The CLI wires this to a real exec; tests pass a mock.
 * The runner is responsible for ALL transport concerns (local vs remote,
 * config path, error mapping). introspectD1 only knows about SQL queries.
 */
export type D1Runner = (sql: string) => Promise<string>;

/** Private shorthand for the exec helper used throughout this module. */
type Exec = (sql: string) => Promise<Record<string, unknown>[]>;

export interface IntrospectD1Options {
  runner: D1Runner;
  /**
   * Documented passthrough — the CLI wiring uses binding/remote/configPath to
   * construct the runner; introspectD1 itself only dispatches SQL via opts.runner.
   * They live on the options so the wiring contract is self-documenting at the call site.
   */
  binding: string;
  remote: boolean;
  configPath: string | undefined;
}

export async function introspectD1(opts: IntrospectD1Options): Promise<SchemaSnapshot> {
  const exec: Exec = async (sql: string) => {
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
    // Issue pragma_table_info ONCE per table; extractColumns + extractPrimaryKey
    // consume the same rows without re-querying (each query is a wrangler round-trip).
    const tableInfoRows = await readTableInfo(exec, name);
    const cols = extractColumns(tableInfoRows);
    const pk = extractPrimaryKey(tableInfoRows);
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

async function readTableInfo(exec: Exec, table: string): Promise<Record<string, unknown>[]> {
  return exec(`SELECT * FROM pragma_table_info('${table}') ORDER BY cid`);
}

function extractColumns(rows: Record<string, unknown>[]): ColumnDescriptor[] {
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

function extractPrimaryKey(rows: Record<string, unknown>[]): string[] {
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

async function readIndexes(exec: Exec, table: string): Promise<IndexDescriptor[]> {
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

async function readForeignKeys(exec: Exec, table: string): Promise<FkDescriptor[]> {
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

async function readViews(exec: Exec): Promise<ViewDescriptor[]> {
  const rows = await exec(
    "SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => ({ name: String(r.name) }));
}

