import type {
  PersistenceDriver, SelectSpec, CountSpec, InsertSpec, InsertManySpec,
  UpdateSpec, UpdateManySpec, DeleteSpec, DeleteManySpec, WhereClause, Row,
} from "../persistence-driver.js";
import { ConstraintViolationError } from "../errors.js";

export interface InMemoryDriverOptions {
  /** Initial table data: { tableName: Row[] }. */
  seed?: Record<string, Row[]>;
  /** Per-table PK field names (used to detect collisions + auto-increment). Default: ["id"]. */
  pkFields?: Record<string, string[]>;
  /** Auto-increment counter starting value per table. Default: 1 + max existing PK. */
  startCounters?: Record<string, number>;
}

interface State {
  // Outer key: table name. Inner key: pk values joined by REF_PK_SEPARATOR (",").
  tables: Map<string, Map<string, Row>>;
  pkFields: Map<string, string[]>;
  counters: Map<string, number>;
}

export function inMemoryDriver(opts: InMemoryDriverOptions = {}): PersistenceDriver {
  const state = createState(opts);
  return makeDriver(state);
}

function createState(opts: InMemoryDriverOptions): State {
  const tables = new Map<string, Map<string, Row>>();
  const pkFields = new Map<string, string[]>();
  const counters = new Map<string, number>();

  for (const [tableName, rows] of Object.entries(opts.seed ?? {})) {
    const pk = opts.pkFields?.[tableName] ?? ["id"];
    pkFields.set(tableName, pk);
    const map = new Map<string, Row>();
    let maxNumericPk = 0;
    for (const row of rows) {
      const key = pkKey(row, pk);
      map.set(key, structuredClone(row));
      const v = row[pk[0]!];
      if (typeof v === "number" && v > maxNumericPk) maxNumericPk = v;
    }
    tables.set(tableName, map);
    counters.set(tableName, opts.startCounters?.[tableName] ?? maxNumericPk + 1);
  }

  return { tables, pkFields, counters };
}

function makeDriver(state: State): PersistenceDriver {
  const ensureTable = (table: string): Map<string, Row> => {
    let t = state.tables.get(table);
    if (!t) {
      t = new Map();
      state.tables.set(table, t);
      state.pkFields.set(table, ["id"]);
      state.counters.set(table, 1);
    }
    return t;
  };

  const ensurePk = (table: string): string[] => {
    let pk = state.pkFields.get(table);
    if (!pk) {
      pk = ["id"];
      state.pkFields.set(table, pk);
    }
    return pk;
  };

  return {
    dialect: "memory",

    async selectOne(spec) {
      const rows = await this.selectMany({ ...spec, limit: 1 });
      return rows[0] ?? null;
    },

    async selectMany(spec) {
      const t = state.tables.get(spec.table);
      if (!t) return [];
      let rows = [...t.values()].filter((r) => matchesWhere(r, spec.where));
      if (spec.orderBy) {
        for (const ob of [...spec.orderBy].reverse()) {
          rows.sort((a, b) => compareValues(a[ob.column], b[ob.column]) * (ob.direction === "asc" ? 1 : -1));
        }
      }
      if (spec.offset) rows = rows.slice(spec.offset);
      if (spec.limit !== undefined) rows = rows.slice(0, spec.limit);
      return rows.map((r) => projectColumns(r, spec.columns));
    },

    async count(spec) {
      const t = state.tables.get(spec.table);
      if (!t) return 0;
      return [...t.values()].filter((r) => matchesWhere(r, spec.where)).length;
    },

    async insert(spec) {
      const t = ensureTable(spec.table);
      const pk = ensurePk(spec.table);
      const row = { ...spec.values };
      for (const f of pk) {
        if (row[f] === undefined || row[f] === null) {
          if (pk.length !== 1) {
            throw new ConstraintViolationError(
              `Composite PK requires all values; missing ${f}`, { kind: "not_null", table: spec.table, field: f },
            );
          }
          const next = state.counters.get(spec.table) ?? 1;
          row[f] = next;
          state.counters.set(spec.table, next + 1);
        }
      }
      const key = pkKey(row, pk);
      if (t.has(key)) {
        throw new ConstraintViolationError(
          `Unique violation on ${spec.table} PK ${key}`, { kind: "unique", table: spec.table, field: pk[0]! },
        );
      }
      t.set(key, structuredClone(row));
      return projectColumns(row, spec.returning);
    },

    async insertMany(spec) {
      const out: Row[] = [];
      for (const values of spec.rows) {
        out.push(await this.insert({ table: spec.table, values, returning: spec.returning }));
      }
      return out;
    },

    async update(spec) {
      const t = state.tables.get(spec.table);
      if (!t) return null;
      const matches = [...t.entries()].filter(([, r]) => matchesWhere(r, spec.where));
      if (matches.length === 0) return null;
      const [key, row] = matches[0]!;
      const updated = { ...row, ...spec.values };
      t.set(key, structuredClone(updated));
      return projectColumns(updated, spec.returning);
    },

    async updateMany(spec) {
      const t = state.tables.get(spec.table);
      if (!t) return 0;
      let n = 0;
      for (const [key, row] of t.entries()) {
        if (!matchesWhere(row, spec.where)) continue;
        t.set(key, structuredClone({ ...row, ...spec.values }));
        n++;
      }
      return n;
    },

    async delete(spec) {
      return this.deleteMany(spec);
    },

    async deleteMany(spec) {
      const t = state.tables.get(spec.table);
      if (!t) return 0;
      const keysToDelete = [...t.entries()].filter(([, r]) => matchesWhere(r, spec.where)).map(([k]) => k);
      for (const k of keysToDelete) t.delete(k);
      return keysToDelete.length;
    },

    async transaction(fn) {
      const snapshot = snapshotState(state);
      try {
        return await fn(this);
      } catch (err) {
        restoreState(state, snapshot);
        throw err;
      }
    },
  };
}

function projectColumns(row: Row, columns: string[]): Row {
  if (columns.length === 0) return { ...row };
  const out: Row = {};
  for (const c of columns) {
    if (c in row) out[c] = row[c];
  }
  return out;
}

function pkKey(row: Row, pkFields: string[]): string {
  return pkFields.map((f) => String(row[f])).join(",");
}

function matchesWhere(row: Row, where?: WhereClause): boolean {
  if (!where) return true;
  switch (where.kind) {
    case "eq":
      return row[where.column] === where.value;
    case "ne":
      return row[where.column] !== where.value;
    case "gt":
      return compareValues(row[where.column], where.value) > 0;
    case "gte":
      return compareValues(row[where.column], where.value) >= 0;
    case "lt":
      return compareValues(row[where.column], where.value) < 0;
    case "lte":
      return compareValues(row[where.column], where.value) <= 0;
    case "in":
      return where.values.some((v) => row[where.column] === v);
    case "like":
      return likeMatch(row[where.column], where.pattern);
    case "isNull": {
      const isNull = row[where.column] === null || row[where.column] === undefined;
      return where.not ? !isNull : isNull;
    }
    case "and":
      return where.clauses.every((c) => matchesWhere(row, c));
    default: {
      const exhaustive: never = where;
      throw new Error(`Unhandled WhereClause kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// SQL LIKE: % → .*, _ → ., case-sensitive. Other regex metacharacters in `pattern` are escaped first.
function likeMatch(value: unknown, pattern: string): boolean {
  if (typeof value !== "string") return false;
  const re = new RegExp("^" + pattern.replace(/[.+*?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
  return re.test(value);
}

function snapshotState(state: State): State {
  return {
    tables: new Map([...state.tables.entries()].map(([t, m]) => [t, new Map([...m.entries()].map(([k, r]) => [k, structuredClone(r)]))])),
    pkFields: new Map(state.pkFields),
    counters: new Map(state.counters),
  };
}

function restoreState(state: State, snapshot: State): void {
  state.tables.clear();
  for (const [t, m] of snapshot.tables.entries()) state.tables.set(t, m);
  state.pkFields.clear();
  for (const [k, v] of snapshot.pkFields.entries()) state.pkFields.set(k, v);
  state.counters.clear();
  for (const [k, v] of snapshot.counters.entries()) state.counters.set(k, v);
}
