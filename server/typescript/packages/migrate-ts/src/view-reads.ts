// src/view-reads.ts
import type { ViewDescriptor } from "./types.js";

/**
 * Identifier matches, compiled once per name: a wide schema diff revisits the same table
 * and column names across views, and recompiling a RegExp per test would rebuild identical
 * state over and over.
 */
const identifierRes = new Map<string, RegExp>();

/**
 * Does `sql` name `identifier`, quoted or bare? A textual match. It can over-report (a
 * column name that is also an alias, a table name that is also a column), which is the safe
 * direction: a wrongly recreated view costs a drop and a create, a missed one fails the
 * table change at apply.
 */
export function sqlNamesIdentifier(sql: string, identifier: string): boolean {
  let re = identifierRes.get(identifier);
  if (re === undefined) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<![A-Za-z0-9_])"?${escaped}"?(?![A-Za-z0-9_])`, "i");
    identifierRes.set(identifier, re);
  }
  return re.test(sql);
}

/**
 * Does the view in the database read `table`, by the name the table has there? The body an
 * engine stores names every table it reads: Postgres deparses it, SQLite keeps it verbatim.
 * A live view with no recorded body is taken to read it.
 */
export function liveViewReadsTable(live: ViewDescriptor, table: string): boolean {
  return live.sql === undefined || sqlNamesIdentifier(live.sql, table);
}
