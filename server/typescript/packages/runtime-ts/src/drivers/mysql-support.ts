// MySQL support shared by the Kysely and Drizzle ObjectManager drivers.
//
// MySQL has no RETURNING, so a driver writes and then reads the row back:
//   - insert: the key is the written key columns, plus the AUTO_INCREMENT id the server
//     reports when the table has one and the caller did not supply it;
//   - update: the row is re-selected with the same WHERE (absent → null).
// Constraint errors are recognised by mysql2's error `code`, walked through any wrapper's
// `cause` chain (Drizzle wraps driver errors).
import type { Row } from "../persistence-driver.js";

export type ConstraintKindName = "unique" | "foreign_key" | "not_null" | "check";

const MYSQL_CODES: Record<string, ConstraintKindName> = {
  ER_DUP_ENTRY: "unique",
  ER_NO_REFERENCED_ROW_2: "foreign_key",
  ER_ROW_IS_REFERENCED_2: "foreign_key",
  ER_NO_REFERENCED_ROW: "foreign_key",
  ER_ROW_IS_REFERENCED: "foreign_key",
  ER_BAD_NULL_ERROR: "not_null",
  ER_CHECK_CONSTRAINT_VIOLATED: "check",
};

/** The constraint kind a mysql2 error (or a wrapper around one) reports, else null. */
export function mysqlConstraintKind(err: unknown): ConstraintKindName | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && typeof cur === "object" && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code in MYSQL_CODES) return MYSQL_CODES[code]!;
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return null;
}

/**
 * The key-column values of a row just inserted: every key column the caller wrote, and the
 * server-generated AUTO_INCREMENT id for the one it did not. `undefined` when a key column
 * has neither (the insert cannot be read back).
 */
export function insertedKey(
  key: readonly string[],
  values: Row,
  insertId: number | bigint | undefined,
): Row | undefined {
  const out: Row = {};
  let usedInsertId = false;
  for (const col of key) {
    const v = values[col];
    if (v !== undefined && v !== null) {
      out[col] = v;
    } else if (!usedInsertId && insertId !== undefined && Number(insertId) !== 0) {
      out[col] = typeof insertId === "bigint" ? Number(insertId) : insertId;
      usedInsertId = true;
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * A row a SQL driver without an array type can bind (SQLite, MySQL). mysql2 expands a JS
 * array into a value LIST (`'x', 'y'`), breaking the column count, and libsql cannot bind one
 * at all; a scalar array lives in a JSON (MySQL) or JSON-in-TEXT (SQLite) column, so it is sent
 * as JSON text. Objects already arrive as JSON text from the type coercer. Drizzle's JSON
 * column modes encode for themselves, so only the Kysely driver calls this.
 */
export function arraysAsJsonText(values: Row): Row {
  let out: Row | null = null;
  for (const [k, v] of Object.entries(values)) {
    if (!Array.isArray(v)) continue;
    out ??= { ...values };
    out[k] = JSON.stringify(v);
  }
  return out ?? values;
}
