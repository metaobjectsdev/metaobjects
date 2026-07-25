/**
 * Shared SQLite catalog helpers used by both the Kysely-based introspector
 * (sqlite.ts) and the wrangler-based D1 introspector (d1.ts).
 *
 * All three routines are pure mappings of SQLite's declared type / pragma
 * values to canonical migrate-ts types and carry no I/O dependencies.
 */
import type { CheckDescriptor, ColumnDefault, FkAction, IndexDescriptor } from "../types.js";
import type { SqlType } from "../sql-type.js";

export const SQLITE_EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(.*\)/,
] as const;

export function parseSqliteDefault(raw: string | null): ColumnDefault | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;

  // A bare (unquoted) NULL keyword is SQL for "no default": `DEFAULT NULL` is
  // functionally identical to declaring no default at all. It reaches us as the
  // JSON string "null" from the D1/wrangler runner (which stringifies a SQL NULL
  // dflt_value) or as `NULL` from parsed DDL. A GENUINE string literal default of
  // "null" is QUOTED (`'null'`) and is matched by the quoted branch below, so this
  // bare test is unambiguous. Without it every no-default column on D1 reads back a
  // literal "null" default that no metadata field ever declares — permanent, and on
  // SQLite/D1 destructive (recreate-and-copy) false drift on every verify/migrate.
  if (raw.trim().toLowerCase() === "null") return undefined;

  // A QUOTE-WRAPPED value is a string literal BY CONSTRUCTION — SQLite always quotes a
  // literal string default. This test MUST come before the expr patterns: one of those
  // patterns is a bare /\(.*\)/, so a perfectly ordinary literal containing parentheses
  // (`@default "n/a (unknown)"` → stored as `'n/a (unknown)'`) would otherwise be
  // classified an EXPR with its quotes still attached. It could then never string-equal
  // the expected literal, so the diff would report change-column-default on EVERY run —
  // and on SQLite (no ALTER COLUMN) that recreate-and-copies the whole table, forever,
  // un-gated, with `verify --db` permanently red. Exactly the failure this un-escaping
  // was added to prevent.
  //
  // Then un-double the emitter's `''` escaping (`@default "don't"` → `'don''t'`), or the
  // introspected `don''t` never equals the expected `don't` — same perpetual rebuild.
  const quoted = /^'([\s\S]*)'$/.exec(raw);
  if (quoted !== null) {
    return { kind: "literal", value: quoted[1]!.replace(/''/g, "'") };
  }

  const isExpr = SQLITE_EXPR_DEFAULT_PATTERNS.some((re) => re.test(raw));
  if (isExpr) return { kind: "expr", value: raw };
  return { kind: "literal", value: raw };
}

export function sqliteTypeToSqlType(declaredType: string): SqlType {
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

/**
 * Parse NAMED CHECK constraints (`CONSTRAINT <name> CHECK (<expr>)`) out of a
 * table's CREATE TABLE statement (sqlite_master.sql). SQLite exposes no pragma
 * for CHECK constraints, so the stored DDL text is the only catalog.
 *
 * This is what makes CHECK evolution CONVERGE on sqlite: the diff proposes a
 * check change → the emitter recreate-and-copies the table with the new inline
 * CHECK → this reads the very DDL that recreate wrote, so the re-diff is empty.
 * Without it the actual side always reported `checks: []` and every expected
 * check re-surfaced as add-check on every single run.
 *
 * Unnamed inline checks (`CHECK (…)` with no CONSTRAINT clause — the idiomatic
 * hand-written-migration form) ARE parsed, with an empty name. They have no
 * identity to match by name, so the diff reconciles them by NORMALIZED EXPRESSION
 * on sqlite/d1: an anonymous DB check that already enforces a modeled constraint
 * is matched to the expected named check rather than re-proposed as add-check.
 * (Before, they were skipped entirely, so every modeled check over such a table
 * re-surfaced as false drift on `verify --dialect d1` on every run.)
 *
 * The expression is scanned with balanced parens and string-literal awareness
 * (an enum member may contain `(`/`)`), and returned verbatim — the diff's
 * checkExprEquals normalizes both sides before comparing.
 */
export function parseSqliteChecks(createSql: string | null | undefined): CheckDescriptor[] {
  if (createSql === null || createSql === undefined || createSql === "") return [];
  const out: CheckDescriptor[] = [];
  // Find `CHECK (` on a MASKED copy (comments + single-quoted literals blanked to
  // spaces of equal length) so a `CHECK (` appearing inside a `--`/`/* */` comment
  // or a string literal (`DEFAULT 'see CHECK (x)'`) can NEVER be mis-parsed as a
  // constraint. Positions are 1:1, so the balanced expression is sliced from the
  // ORIGINAL (with its real quotes intact).
  const masked = maskCommentsAndStrings(createSql);
  // An optional `CONSTRAINT <name>` prefix then `CHECK (`. Named → group 1/2;
  // bare inline `CHECK (` → name defaults to "" (anonymous, expression-matched).
  const re = /(?:\bCONSTRAINT\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))\s+)?\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1] !== undefined ? m[1].replace(/""/g, '"') : (m[2] ?? "");
    const open = re.lastIndex - 1; // position of the "(" the regex just consumed
    let depth = 0;
    let inString = false;
    let close = -1;
    for (let i = open; i < createSql.length; i++) {
      const ch = createSql[i];
      if (inString) {
        if (ch === "'") {
          if (createSql[i + 1] === "'") i++; // '' escape inside the literal
          else inString = false;
        }
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) break; // malformed tail — stop rather than mis-slice
    out.push({ name, expression: createSql.slice(open + 1, close).trim() });
    re.lastIndex = close + 1;
  }
  return out;
}

/**
 * Same-length copy of a CREATE TABLE DDL with SQL comments (`--` line, `/* *\/`
 * block) and single-quoted string literals blanked to spaces, so a token scan
 * (e.g. the CHECK finder) cannot match inside them. Double-quoted identifiers are
 * PRESERVED — a constraint or column name may be double-quoted, and none legitimately
 * contains a `CHECK (` token. Positions are unchanged for downstream slicing.
 */
function maskCommentsAndStrings(sql: string): string {
  const chars = sql.split("");
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      const end = skipSingleQuoted(sql, i);
      for (let j = i; j < end; j++) chars[j] = " ";
      i = end;
    } else if (ch === '"') {
      i = skipDoubleQuoted(sql, i); // preserve the identifier verbatim
    } else if (ch === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") { chars[j] = " "; j++; }
      i = j;
    } else if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      const end = Math.min(n, j + 2);
      for (let k = i; k < end; k++) chars[k] = " ";
      i = end;
    } else {
      i++;
    }
  }
  return chars.join("");
}

/** Skip a single-quoted SQL string starting at `i` (position of the opening
 *  quote); returns the position just past the closing quote ('' escapes honored). */
function skipSingleQuoted(s: string, i: number): number {
  i++;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Skip a double-quoted SQL identifier starting at `i`; "" escapes honored. */
function skipDoubleQuoted(s: string, i: number): number {
  i++;
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return i;
}

export interface ParsedSqliteIndexDef {
  /** Raw key-list text between the balanced parens after `ON <table>`. */
  keyList: string;
  /** Raw partial-index predicate after WHERE; undefined for a full index. */
  where?: string;
}

/**
 * Parse a stored `CREATE [UNIQUE] INDEX … ON <table> (<keys>) [WHERE <pred>]`
 * statement (sqlite_master.sql). SQLite has no pragma exposing an index's key
 * EXPRESSIONS or its partial-index predicate — the stored DDL is the only
 * catalog — so this powers reading `@expr` / `@where` indexes back for the diff
 * to converge. Quote-aware: parens inside string literals or quoted identifiers
 * never confuse the balanced scan.
 */
export function parseSqliteIndexDef(createSql: string | null | undefined): ParsedSqliteIndexDef | undefined {
  if (createSql === null || createSql === undefined || createSql === "") return undefined;
  const n = createSql.length;
  // First "(" outside any quoted region = start of the key list.
  let open = -1;
  for (let i = 0; i < n; ) {
    const ch = createSql[i];
    if (ch === "'") { i = skipSingleQuoted(createSql, i); continue; }
    if (ch === '"') { i = skipDoubleQuoted(createSql, i); continue; }
    if (ch === "(") { open = i; break; }
    i++;
  }
  if (open === -1) return undefined;
  // Balanced scan (quote-aware) to the matching ")".
  let close = -1;
  for (let i = open, depth = 0; i < n; ) {
    const ch = createSql[i];
    if (ch === "'") { i = skipSingleQuoted(createSql, i); continue; }
    if (ch === '"') { i = skipDoubleQuoted(createSql, i); continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
    i++;
  }
  if (close === -1) return undefined;
  const out: ParsedSqliteIndexDef = { keyList: createSql.slice(open + 1, close).trim() };
  const m = /^\s*WHERE\s+([\s\S]+)$/i.exec(createSql.slice(close + 1));
  if (m) out.where = m[1]!.trim().replace(/;\s*$/, "");
  return out;
}

/** pragma_index_list row, dialect-neutrally coerced by the caller. */
export interface SqliteIndexListEntry {
  name: string;
  unique: boolean;
  partial: boolean;
}

/** A KEY column row from pragma_index_xinfo (key=1 rows only, seqno order). */
export interface SqliteIndexKeyColumn {
  /** Column name; null for an expression key (cid = -2). */
  name: string | null;
  /** true when the key is sorted DESC. */
  desc: boolean;
}

/**
 * Assemble an IndexDescriptor from the SQLite catalog pieces: pragma_index_list
 * (unique/partial), pragma_index_xinfo key columns (names + DESC bits; name null
 * for an expression key), and the stored CREATE INDEX DDL (expression key list +
 * partial predicate — neither is exposed by any pragma).
 *
 * Mirrors the expected side's shape rules: an expression index carries the whole
 * key list in `expr` with `columns: []`; `orders` is attached only when some key
 * is DESC (all-ascending serializes as absent, like buildExpectedSchema).
 */
export function buildSqliteIndexDescriptor(
  entry: SqliteIndexListEntry,
  keyColumns: readonly SqliteIndexKeyColumn[],
  createSql: string | null | undefined,
): IndexDescriptor {
  const parsed = parseSqliteIndexDef(createSql);
  const descriptor: IndexDescriptor = {
    name: entry.name,
    columns: [],
    unique: entry.unique,
  };
  if (keyColumns.some((c) => c.name === null)) {
    // Expression key somewhere in the list → the whole key list is the expr
    // (same convention as the Postgres introspector + buildExpectedSchema).
    if (parsed !== undefined) descriptor.expr = parsed.keyList;
  } else {
    descriptor.columns = keyColumns.map((c) => c.name!);
    const orders = keyColumns.map((c): "asc" | "desc" => (c.desc ? "desc" : "asc"));
    if (orders.some((o) => o === "desc")) descriptor.orders = orders;
  }
  if (entry.partial && parsed?.where !== undefined) descriptor.where = parsed.where;
  return descriptor;
}

export function sqliteRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}
