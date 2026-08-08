/**
 * Postgres introspection — stage 2 of the migration pipeline.
 *
 * Produces a SchemaSnapshot from a live Kysely<Record<string, unknown>> pointing at a Postgres
 * (or pg-mem) database.
 *
 * Design notes:
 * - We deliberately avoid Kysely's built-in db.introspection.getTables() because
 *   it uses the `!~` regex operator in its internal query, which pg-mem (v3) does
 *   not support. We read information_schema directly via raw SQL instead.
 * - Primary keys come from information_schema.table_constraints +
 *   key_column_usage. Real Postgres returns rows; pg-mem (v3) returns empty rows
 *   for both views — so PK tests are gated on MIGRATE_TS_PG_URL in the test file.
 * - Default values come from information_schema.columns.column_default. pg-mem
 *   always returns null for this column, so default tests are gated too.
 * - Type normalization (pgTypeToSqlType) is exported so it can be unit-tested
 *   without a live DB.
 *
 * pg-mem gaps (documented here, gated in the test file):
 *   - information_schema.columns.character_maximum_length → always null
 *   - information_schema.columns.column_default → always null
 *   - information_schema.table_constraints / key_column_usage → empty rows
 *   - bigserial appears as "integer" (no sequence differentiation)
 *   - array_position() not implemented → pg_index catalog query throws;
 *     readPgIndexes() catches and returns [] on pg-mem
 *   - information_schema.referential_constraints not supported →
 *     readPgForeignKeys() catches and returns [] on pg-mem
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { SchemaSnapshot, TableDescriptor, ColumnDescriptor, ColumnDefault, IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor, CheckDescriptor } from "../types.js";
import type { SqlType } from "../sql-type.js";
import type { DependentRelation } from "../types.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
import { parseFingerprintMarker } from "../view-fingerprint.js";
import { MIGRATIONS_TABLE } from "../apply/ledger.js";
import { stripCheckWrapper } from "../check-expr-compare.js";
import { isPgAutoSequenceDefault } from "../pg-identity-default.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function introspectPostgres(db: Kysely<Record<string, unknown>>): Promise<SchemaSnapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const k = db as Kysely<any>;

  const tableRefs = await readTableNames(k);
  const tables: TableDescriptor[] = [];

  for (const { schema, name } of tableRefs) {
    const columns = await readColumns(k, schema, name);
    const primaryKey = await readPrimaryKey(k, schema, name);
    tables.push({
      name,
      schema,
      columns,
      indexes: await readPgIndexes(k, schema, name),
      foreignKeys: await readPgForeignKeys(k, schema, name),
      checks: await readPgChecks(k, schema, name),
      primaryKey,
    });
  }

  const views = await readPgViews(k);
  return {
    tables,
    views,
  };
}

// ---------------------------------------------------------------------------
// Helpers — all exported so they can be tested in isolation
// ---------------------------------------------------------------------------

/**
 * Normalise a PG column data type string into a canonical SqlType.
 * The `dataType` string comes from information_schema.columns.data_type (or
 * occasionally from information_schema.columns.udt_name).  Both are lower-cased
 * before matching.
 *
 * If character_maximum_length is available, callers should pass `maxLength`.
 *
 * `numeric` carries its qualifier OUT-OF-BAND: `data_type` is a bare "numeric"
 * for both NUMERIC and NUMERIC(9,4), so callers reading information_schema must
 * pass `numeric.precision` / `numeric.scale` (from numeric_precision /
 * numeric_scale) or the qualifier is lost. An inline "numeric(9,4)" string is
 * still parsed — that form arrives from format_type()/pg_catalog callers and
 * from unit tests — but it is NOT what information_schema produces.
 *
 * Only the numeric/decimal branch consults the qualifier: information_schema
 * also populates numeric_precision for INTEGER columns (int4 → 32, radix 2),
 * which has nothing to do with a NUMERIC qualifier.
 */
export function pgTypeToSqlType(
  dataType: string,
  maxLength?: number | null,
  udtName?: string,
  numeric?: { precision: number | null; scale: number | null },
): SqlType {
  const dt = dataType.toLowerCase().trim();

  // Array columns: information_schema reports data_type "ARRAY" and the element
  // type in udt_name with a leading underscore (e.g. "_uuid", "_text", "_varchar").
  // The element is deliberately left UNQUALIFIED: information_schema reports no
  // qualifiers for array elements (numeric_precision/character_maximum_length are
  // NULL when data_type = 'ARRAY'), and the expected side builds unqualified
  // elements to match (see arrayElementSqlType in expected-schema).
  if (dt === "array" && typeof udtName === "string") {
    const elemUdt = udtName.replace(/^_/, "").toLowerCase();
    return { kind: "array", element: pgTypeToSqlType(elemUdt, maxLength) };
  }

  // Length-bearing text types — may arrive as "character varying(255)" (full
  // inline) or as bare "character varying" with maxLength from a separate column.
  const varcharMatch = /^(?:character varying|varchar)\((\d+)\)$/.exec(dt);
  if (varcharMatch) {
    return { kind: "text", maxLength: parseInt(varcharMatch[1] ?? "0", 10) };
  }
  if (dt === "character varying" || dt === "varchar") {
    return maxLength != null ? { kind: "text", maxLength } : { kind: "text" };
  }
  if (dt === "text") {
    return { kind: "text" };
  }

  // Integer types — serial variants are also covered here; callers supply
  // identity=increment separately via a sequence check.
  if (dt === "int8" || dt === "bigint" || dt === "bigserial") {
    return { kind: "integer", bits: 64 };
  }
  if (
    dt === "int4" || dt === "integer" || dt === "serial" ||
    dt === "int2" || dt === "smallint" || dt === "smallserial" ||
    dt === "int"
  ) {
    return { kind: "integer", bits: 32 };
  }

  // Floating-point: float4/real is single precision; float8/double precision is double.
  if (dt === "float4" || dt === "real") return { kind: "real4" };
  if (dt === "float8" || dt === "double precision") return { kind: "real" };

  // Arbitrary-precision numeric — "numeric(p,s)" or bare "numeric"/"decimal".
  // An inline qualifier wins when present; otherwise fall back to the
  // out-of-band numeric_precision/numeric_scale, which is the only form
  // information_schema ever gives us. An unconstrained NUMERIC reports both as
  // NULL and stays a bare { kind: "numeric" }.
  const numMatch = /^(?:numeric|decimal)(?:\((\d+)(?:,\s*(\d+))?\))?$/.exec(dt);
  if (numMatch) {
    const out: SqlType = { kind: "numeric" };
    const precision = numMatch[1] !== undefined ? parseInt(numMatch[1], 10) : numeric?.precision ?? null;
    const scale = numMatch[1] !== undefined
      ? (numMatch[2] !== undefined ? parseInt(numMatch[2], 10) : null)
      : numeric?.scale ?? null;
    if (precision !== null) out.precision = precision;
    if (scale !== null) out.scale = scale;
    return out;
  }

  // Boolean
  if (dt === "bool" || dt === "boolean") return { kind: "boolean" };

  // Date + time
  if (dt === "date") return { kind: "date" };
  if (dt === "time" || dt === "time without time zone") return { kind: "time" };
  if (dt === "timestamp" || dt === "timestamp without time zone") {
    return { kind: "timestamp", withTimezone: false };
  }
  if (dt === "timestamptz" || dt === "timestamp with time zone") {
    return { kind: "timestamp", withTimezone: true };
  }

  // JSON
  if (dt === "json" || dt === "jsonb") return { kind: "json" };

  // Binary
  if (dt === "bytea") return { kind: "blob" };

  // UUID
  if (dt === "uuid") return { kind: "uuid" };

  // INET (ADR-0036/0037 Wave 3 — field.inet)
  if (dt === "inet") return { kind: "inet" };

  // Unknown types (user-defined enums, citext, ltree, etc.) fall back to text
  // so we don't blow up on unrecognised types.
  return { kind: "text" };
}

/**
 * Parse a raw PG column_default string into a ColumnDefault.
 * Returns undefined if the default is absent or empty.
 *
 * Classification rules:
 *   - Expressions: now(), CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, and any
 *     bare function-call (e.g. nextval(...), gen_random_uuid(), uuid_generate_v4()),
 *     plus any value that starts with a non-quote character and contains a `::` cast
 *     (i.e. bare identifier with cast, like `NULL::text`).
 *   - Literals: `'value'` (optionally followed by `::type` cast, which PG
 *     commonly appends for clarity). The cast is stripped; the value is unquoted.
 *
 * PG stores literal booleans as `'true'::boolean`, integers as `'42'::integer`,
 * strings as `'hello'::text` — all are literals after stripping the cast.
 *
 * The bare function-call rule keeps this in lockstep with the metadata-side
 * default classifier (expected-schema's EXPR_DEFAULT_PATTERNS, which treats any
 * `()` default as an expression): without it, a `gen_random_uuid()` column default
 * round-trips as a literal here but an expression there, producing a spurious
 * column diff on every uuid-PK table.
 */
export function parsePgDefault(raw: string | null | undefined): ColumnDefault | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;

  // Function-call or keyword expressions. The leading-identifier-then-"(" rule
  // matches any bare function call (gen_random_uuid(), uuid_generate_v4(), …)
  // while never matching a quoted literal (those start with a single quote and are
  // handled below).
  if (
    /^now\(\)$/i.test(raw) ||
    /^current_timestamp\b/i.test(raw) ||
    /^current_date\b/i.test(raw) ||
    /^current_time\b/i.test(raw) ||
    /^nextval\(/i.test(raw) ||
    /^[a-zA-Z_][\w.]*\s*\(/.test(raw)
  ) {
    return { kind: "expr", value: raw };
  }

  // If it starts with a single-quote, it's a quoted literal (possibly with
  // a trailing ::type cast that PG appends for type clarity).
  if (raw.startsWith("'")) {
    // Strip the cast suffix (e.g. `::boolean`, `::text`, `::integer`)
    const withoutCast = raw.replace(/::[^']+$/, "");
    // Strip the surrounding single-quotes, then un-double the embedded `''`
    // escapes PG stores verbatim (e.g. `'don''t'::text`) — without this the
    // introspected value never equals the expected literal and the diff issues
    // a bogus SET DEFAULT on every run.
    const m = /^'(.*)'$/.exec(withoutCast);
    const cleaned = m !== null ? m[1]!.replace(/''/g, "'") : withoutCast;
    return { kind: "literal", value: cleaned };
  }

  // Anything else that contains a :: cast is a complex expression
  // (e.g. NULL::text, ARRAY[]::text[])
  if (/::/g.test(raw)) {
    return { kind: "expr", value: raw };
  }

  // Bare literal (no quotes, no cast)
  return { kind: "literal", value: raw };
}

// ---------------------------------------------------------------------------
// Internal — raw SQL queries
// ---------------------------------------------------------------------------

interface SchemaTableRef {
  schema: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTableNames(k: Kysely<any>): Promise<SchemaTableRef[]> {
  const rows = await sql<{ table_name: string; table_schema: string }>`
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_schema NOT LIKE 'pg_%'
      AND table_type = 'BASE TABLE'
      AND table_name <> ${MIGRATIONS_TABLE}
    ORDER BY table_schema, table_name
  `.execute(k);
  return rows.rows.map((r) => ({ schema: r.table_schema, name: r.table_name }));
}

async function readPgViews(k: RawKysely): Promise<ViewDescriptor[]> {
  // pg-mem gap: the catalog joins below are not supported — the query throws.
  // We catch and return [] so other tests still pass on pg-mem. Real PG
  // (Postgres 16) handles this correctly.
  try {
    // pg_get_viewdef returns the SELECT body (not the full CREATE VIEW
    // statement — same shape information_schema.view_definition had). We carry
    // it through on the descriptor so the diff can detect view-body drift (not
    // just name presence).
    //
    // EXTENSION-OWNED views are excluded (pg_depend deptype 'e'): a view that
    // `CREATE EXTENSION` installed (e.g. pg_stat_statements drops one into
    // `public`) belongs to the extension, not the model — reporting it makes
    // the very next migrate propose `DROP VIEW "pg_stat_statements";`, and
    // dropping it would break the extension.
    const rows = await sql<{
      table_name: string;
      table_schema: string;
      view_definition: string | null;
      view_comment: string | null;
    }>`
      SELECT c.relname AS table_name,
             n.nspname AS table_schema,
             pg_get_viewdef(c.oid) AS view_definition,
             obj_description(c.oid, 'pg_class') AS view_comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
        )
      ORDER BY n.nspname, c.relname
    `.execute(k);

    const dependents = await readPgViewDependents(k);

    const views: ViewDescriptor[] = [];
    for (const r of rows.rows) {
      const view: ViewDescriptor = { name: r.table_name, schema: r.table_schema };
      // The deparsed body. NOT a comparison input on Postgres — pg_get_viewdef
      // regenerates SQL from the parse tree and can never return the text we wrote.
      // It IS valid SQL that reproduces the view, so it is the restore payload for a
      // down migration.
      if (r.view_definition) view.sql = r.view_definition;
      // The fingerprint is what the diff actually compares. Absent ⇒ the view carries
      // no MetaObjects stamp ⇒ hand-written or pre-fingerprint ⇒ the diff fails closed.
      const marker = parseFingerprintMarker(r.view_comment);
      if (marker !== null) view.fingerprint = marker.fingerprint;
      // A view is a relation: information_schema.columns describes its output columns
      // exactly like a table's, so the same reader gives us the list (and the types)
      // that decide whether a CREATE OR REPLACE is legal.
      view.columns = (await readColumns(k, r.table_schema, r.table_name)).map((c) => ({
        name: c.name,
        sqlType: c.sqlType,
      }));
      views.push(view);
    }

    // Attach dependents, now that we know which views are managed (fingerprinted) —
    // a CASCADE that destroys an UNMANAGED object is the dangerous case.
    const managed = new Set(views.filter((v) => v.fingerprint !== undefined).map((v) => viewKey(v.schema, v.name)));
    for (const view of views) {
      const direct = dependents.get(viewKey(view.schema, view.name));
      if (direct === undefined) continue;
      view.dependents = direct.map((d) => ({ ...d, managed: managed.has(viewKey(d.schema, d.name)) }));
    }
    return views;
  } catch {
    // pg-mem: pg_class/pg_depend catalog introspection not supported — return empty view list.
    return [];
  }
}

function viewKey(schema: string | undefined, name: string): string {
  return `${schema ?? DEFAULT_DB_SCHEMA_POSTGRES}.${name}`;
}

/**
 * Every view's DIRECT dependents, in one query (no per-view N+1). Keyed by the
 * depended-ON view; the transitive closure is computed in the diff.
 *
 * The catalog gotcha: a view's dependency on the relations it reads is NOT recorded as
 * view-depends-on-relation. It is recorded as the view's REWRITE RULE (its `_RETURN`
 * rule in pg_rewrite, which holds the parse tree) depending on each referenced
 * relation. So finding dependents means joining pg_depend → pg_rewrite → pg_class —
 * and every view depends on ITSELF through its own `_RETURN` rule, which must be
 * excluded or a dependency walk never terminates.
 *
 * Materialized views (relkind 'm') are included deliberately: migrate does not manage
 * them, but they can depend on our views and a CASCADE would destroy them anyway.
 */
async function readPgViewDependents(k: RawKysely): Promise<Map<string, Omit<DependentRelation, "managed">[]>> {
  const out = new Map<string, Omit<DependentRelation, "managed">[]>();
  try {
    const rows = await sql<{
      on_schema: string; on_name: string;
      dep_schema: string; dep_name: string; dep_relkind: string;
    }>`
      SELECT ref_ns.nspname   AS on_schema,
             ref_cl.relname   AS on_name,
             dep_ns.nspname   AS dep_schema,
             dep_cl.relname   AS dep_name,
             dep_cl.relkind   AS dep_relkind
      FROM pg_depend d
      JOIN pg_rewrite    r      ON r.oid = d.objid
      JOIN pg_class      dep_cl ON dep_cl.oid = r.ev_class
      JOIN pg_namespace  dep_ns ON dep_ns.oid = dep_cl.relnamespace
      JOIN pg_class      ref_cl ON ref_cl.oid = d.refobjid
      JOIN pg_namespace  ref_ns ON ref_ns.oid = ref_cl.relnamespace
      WHERE d.classid    = 'pg_rewrite'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype    = 'n'
        AND ref_cl.relkind = 'v'
        AND dep_cl.oid <> ref_cl.oid
        AND ref_ns.nspname NOT IN ('pg_catalog', 'information_schema')
        AND ref_ns.nspname NOT LIKE 'pg_%'
    `.execute(k);
    for (const r of rows.rows) {
      if (r.dep_relkind !== "v" && r.dep_relkind !== "m") continue;
      const key = viewKey(r.on_schema, r.on_name);
      const list = out.get(key) ?? [];
      list.push({ schema: r.dep_schema, name: r.dep_name, relkind: r.dep_relkind });
      out.set(key, list);
    }
  } catch {
    // pg-mem: no pg_rewrite. Dependents unknown → treated as none. The real-PG
    // integration tests are the gate for this path.
  }
  return out;
}

interface RawColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;   // 'YES' | 'NO'
  column_default: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readColumns(k: Kysely<any>, schema: string, tableName: string): Promise<ColumnDescriptor[]> {
  // numeric_precision/_scale are the ONLY place a NUMERIC(p,s) qualifier survives:
  // information_schema.columns.data_type reports a bare "numeric" for every
  // NUMERIC column regardless of its qualifier, and character_maximum_length is
  // NULL for numerics. Selecting them is what lets a `field.decimal @precision
  // @scale` column converge — without them the expected side says NUMERIC(9,4),
  // introspection reads back a bare NUMERIC, and the diff reports a (lossy, so
  // BLOCKED) change-column-type on every single migrate, forever.
  const rows = await sql<RawColumn>`
    SELECT
      column_name,
      data_type,
      udt_name,
      character_maximum_length,
      numeric_precision,
      numeric_scale,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = ${schema}
      AND table_name = ${tableName}
    ORDER BY ordinal_position
  `.execute(k);

  return rows.rows.map((r) => {
    const sqlType = pgTypeToSqlType(r.data_type, r.character_maximum_length, r.udt_name, {
      precision: r.numeric_precision,
      scale: r.numeric_scale,
    });
    const col: ColumnDescriptor = {
      name: r.column_name,
      sqlType,
      nullable: r.is_nullable === "YES",
    };

    const def = parsePgDefault(r.column_default);
    if (def !== undefined) col.default = def;

    // Detect auto-increment (sequence) columns — real PG surfaces bigserial /
    // serial as nextval(...) in column_default (isPgAutoSequenceDefault, shared
    // with the diff layer's identity-default guard). We also check udt_name for
    // explicit serial type names as a belt-and-suspenders guard.
    const isSerial =
      isPgAutoSequenceDefault(r.column_default) ||
      /^(?:bigserial|serial8|serial4|serial|smallserial|serial2)$/i.test(r.udt_name);
    if (isSerial) col.identity = "increment";

    return col;
  });
}

// Typed alias for raw Kysely — avoids per-call `as any` casts in the helpers below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawKysely = Kysely<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readPrimaryKey(k: Kysely<any>, schema: string, tableName: string): Promise<string[]> {
  // Uses information_schema only — avoids pg_attribute / pg_constraint joins
  // that are either missing or return empty in pg-mem.
  const rows = await sql<{ column_name: string; ordinal_position: number }>`
    SELECT kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema    = tc.table_schema
      AND kcu.table_name      = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema    = ${schema}
      AND tc.table_name      = ${tableName}
    ORDER BY kcu.ordinal_position
  `.execute(k);
  return rows.rows.map((r) => r.column_name);
}

async function readPgIndexes(k: RawKysely, schema: string, table: string): Promise<IndexDescriptor[]> {
  // pg-mem gap: array_position() is not implemented, so this query throws on
  // pg-mem. We catch and return [] so non-index tests still pass against pg-mem.
  // Real PG (Postgres 16) handles this correctly.
  // One row per index KEY, in key order, carrying: the column name (NULL for an
  // expression key — attnum 0), the DESC bit from `indoption`, and the partial-index
  // predicate (`indpred`, constant per index). unnest WITH ORDINALITY over indkey +
  // indoption keeps the key order and pairs each key with its option flags.
  let rows: {
    rows: Array<{
      index_name: string;
      is_unique: boolean;
      is_primary: boolean;
      column_name: string | null;
      ordinal: number;
      is_desc: boolean;
      predicate: string | null;
      access_method: string;
      indexdef: string;
    }>;
  };
  try {
    rows = await sql<{
      index_name: string;
      is_unique: boolean;
      is_primary: boolean;
      column_name: string | null;
      ordinal: number;
      is_desc: boolean;
      predicate: string | null;
      access_method: string;
      indexdef: string;
    }>`
      SELECT i.relname AS index_name,
             ix.indisunique AS is_unique,
             ix.indisprimary AS is_primary,
             a.attname AS column_name,
             k.ord AS ordinal,
             (COALESCE(opt.option, 0) & 1) = 1 AS is_desc,
             pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
             am.amname AS access_method,
             pg_get_indexdef(ix.indexrelid) AS indexdef
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
      LEFT JOIN LATERAL unnest(ix.indoption) WITH ORDINALITY AS opt(option, oord)
        ON opt.oord = k.ord
      LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
      WHERE n.nspname = ${schema}
        AND t.relname = ${table}
      ORDER BY i.relname, k.ord
    `.execute(k);
  } catch {
    // pg-mem: unnest WITH ORDINALITY / pg_get_expr unsupported — return empty list.
    return [];
  }

  const byName = new Map<
    string,
    {
      isUnique: boolean;
      isPrimary: boolean;
      cols: string[];
      orders: ("asc" | "desc")[];
      predicate: string | null;
      hasExpressionKey: boolean;
      accessMethod: string;
      indexdef: string;
    }
  >();
  for (const r of rows.rows) {
    let entry = byName.get(r.index_name);
    if (!entry) {
      entry = {
        isUnique: r.is_unique,
        isPrimary: r.is_primary,
        cols: [],
        orders: [],
        predicate: r.predicate,
        hasExpressionKey: false,
        accessMethod: r.access_method,
        indexdef: r.indexdef,
      };
      byName.set(r.index_name, entry);
    }
    if (r.column_name === null) {
      // Expression key (attnum 0) — captured from the index def below.
      entry.hasExpressionKey = true;
    } else {
      entry.cols.push(r.column_name);
      entry.orders.push(r.is_desc ? "desc" : "asc");
    }
  }
  return Array.from(byName.entries())
    .filter(([, v]) => !v.isPrimary) // PK index excluded — PK lives in TableDescriptor.primaryKey
    .map(([name, v]) => {
      const using = v.accessMethod !== "btree" ? v.accessMethod : undefined;
      if (v.hasExpressionKey) {
        // Functional/expression index: lift the raw key expression out of the
        // index def (between `USING <am> (` and its matching `)`, before WHERE).
        const ix: IndexDescriptor = { name, columns: [], unique: v.isUnique, expr: indexDefKeyExpr(v.indexdef) };
        if (using) ix.using = using;
        if (v.predicate !== null) ix.where = v.predicate;
        return ix;
      }
      const ix: IndexDescriptor = { name, columns: v.cols, unique: v.isUnique };
      if (using) ix.using = using;
      if (v.orders.some((o) => o === "desc")) ix.orders = v.orders;
      if (v.predicate !== null) ix.where = v.predicate;
      return ix;
    });
}

/** Extract the raw key-expression text from a pg index def — the balanced `(...)`
 *  after `USING <method> `, stripped of a trailing partial-index `WHERE`. */
function indexDefKeyExpr(indexdef: string): string {
  const open = indexdef.indexOf("(", indexdef.indexOf(" USING "));
  if (open === -1) return indexdef;
  let depth = 0;
  for (let i = open; i < indexdef.length; i++) {
    if (indexdef[i] === "(") depth++;
    else if (indexdef[i] === ")") {
      depth--;
      if (depth === 0) return indexdef.slice(open + 1, i).trim();
    }
  }
  return indexdef.slice(open + 1).trim();
}

async function readPgForeignKeys(k: RawKysely, schema: string, table: string): Promise<FkDescriptor[]> {
  // pg-mem gap: information_schema.referential_constraints is not supported —
  // the query returns empty rows or throws. We catch and return [] so other
  // tests still pass on pg-mem. Real PG (Postgres 16) handles this correctly.
  let rows: { rows: Array<{ fk_name: string; column_name: string; ref_table: string; ref_column: string; update_rule: string; delete_rule: string; ordinal: number }> };
  try {
    rows = await sql<{
      fk_name: string;
      column_name: string;
      ref_table: string;
      ref_column: string;
      update_rule: string;
      delete_rule: string;
      ordinal: number;
    }>`
      SELECT tc.constraint_name AS fk_name,
             kcu.column_name,
             ccu.table_name AS ref_table,
             ccu.column_name AS ref_column,
             rc.update_rule,
             rc.delete_rule,
             kcu.ordinal_position AS ordinal
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ${schema}
        AND tc.table_name = ${table}
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `.execute(k);
  } catch {
    // pg-mem: referential_constraints not supported — return empty FK list.
    return [];
  }

  const byName = new Map<string, {
    cols: string[]; refTable: string; refCols: string[];
    onDelete: FkAction; onUpdate: FkAction;
  }>();
  for (const r of rows.rows) {
    let entry = byName.get(r.fk_name);
    if (!entry) {
      entry = {
        cols: [], refTable: r.ref_table, refCols: [],
        onDelete: pgRuleToAction(r.delete_rule),
        onUpdate: pgRuleToAction(r.update_rule),
      };
      byName.set(r.fk_name, entry);
    }
    entry.cols.push(r.column_name);
    entry.refCols.push(r.ref_column);
  }
  return Array.from(byName.entries()).map(([name, v]) => {
    const fk: FkDescriptor = {
      name,
      columns: v.cols,
      refTable: v.refTable,
      refColumns: v.refCols,
    };
    if (v.onDelete !== "no-action") fk.onDelete = v.onDelete;
    if (v.onUpdate !== "no-action") fk.onUpdate = v.onUpdate;
    return fk;
  });
}

function pgRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}

/**
 * Read CHECK constraints for a table from pg_constraint. pg-mem does not support
 * pg_constraint, so this catches and returns [] there (same accepted gap as
 * readPgForeignKeys/readPgIndexes); real-DB coverage is the MIGRATE_TS_PG_URL-gated
 * integration test. `pg_get_constraintdef` returns `CHECK (<expr>)`; the wrapper is
 * stripped to the expression, compared via normalizeCheckExpr at diff time.
 */
async function readPgChecks(k: RawKysely, schema: string, table: string): Promise<CheckDescriptor[]> {
  try {
    const rows = await sql<{ name: string; def: string }>`
      SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE con.contype = 'c' AND rel.relname = ${table} AND ns.nspname = ${schema}
    `.execute(k);
    return rows.rows.map((r) => ({ name: r.name, expression: stripCheckWrapper(r.def) }));
  } catch {
    return []; // pg-mem: pg_constraint unsupported
  }
}
