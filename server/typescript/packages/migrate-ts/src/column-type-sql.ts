// The ONE place a column's dialect SQL type is spelled for a reader.
//
// It does not spell one. It DELEGATES to the exact functions the DDL emitters use —
// `pgType` in emit/postgres.ts, `sqliteType` in emit/sqlite.ts — so a surface that shows
// an adopter "this column is `VARCHAR(200)`" is showing the same string the migration
// would write, by construction rather than by review.
//
// That is the whole reason this file exists rather than a switch in the docs generator:
// a type rendered twice is a type that can disagree with itself, and the disagreement
// would surface as a documentation page quietly describing a schema the tool does not
// produce. The `agent/schema.md` docs surface is the first caller.
//
// D1 is SQLite at the SQL level (the dialect vocabulary's own rule), so it renders
// through the sqlite branch.

import type { ColumnDescriptor, Dialect } from "./types.js";
import { pgType } from "./emit/postgres.js";
import { sqliteType } from "./emit/sqlite.js";

/**
 * The dialect SQL type for one column of a `SchemaSnapshot` table, exactly as the
 * migration emitter would render it in a `CREATE TABLE`.
 *
 * The COLUMN is the argument rather than the bare `SqlType` on purpose: on sqlite an
 * `identity` column's declared type is decided by the identity strategy and not by the
 * canonical type at all (`increment` → `INTEGER`, `uuid` → `TEXT`), so a caller holding
 * only a `SqlType` cannot get the right answer and would not know it was wrong.
 */
export function columnTypeSql(column: ColumnDescriptor, dialect: Dialect): string {
  return dialect === "postgres"
    ? pgType(column.sqlType)
    : sqliteType(column.sqlType, column.identity);
}
