// view-replace-probe.ts — the Postgres implementation of the view-replace probe (see
// view-replace.ts for why the planner asks the database instead of predicting).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
import { readPgViewColumns } from "./introspect/postgres.js";
import type { ViewReplaceProbe } from "./view-replace.js";

const PROBE_NAME = "mo_view_replace_probe";
const ROLLBACK = Symbol("rollback");

/**
 * Run `work` and undo everything it did. On a connection that is already inside a
 * transaction the work is bracketed by a SAVEPOINT, so the caller's transaction is left
 * exactly as it was, still open and still usable even when `work` fails. Otherwise it
 * runs in a transaction of its own, which is rolled back.
 */
async function rolledBack<T>(
  db: Kysely<Record<string, unknown>>,
  work: (q: Kysely<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) {
    await sql.raw(`SAVEPOINT ${PROBE_NAME}`).execute(db);
    try {
      return await work(db);
    } finally {
      await sql.raw(`ROLLBACK TO SAVEPOINT ${PROBE_NAME}`).execute(db);
      await sql.raw(`RELEASE SAVEPOINT ${PROBE_NAME}`).execute(db);
    }
  }
  let result: { value: T } | undefined;
  try {
    await db.transaction().execute(async (trx) => {
      result = { value: await work(trx) };
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return result!.value;
}

const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/**
 * The probe for a live Postgres database. It creates the expected definition as a
 * TEMPORARY view, reads that view's columns and the live view's, and rolls back. The
 * temporary view exists only inside the rolled-back work, so nothing persists.
 */
export function postgresViewReplaceProbe(db: Kysely<Record<string, unknown>>): ViewReplaceProbe {
  return async (expected, live) => {
    const body = expected.sql;
    if (body === undefined) return undefined;
    try {
      return await rolledBack(db, async (q) => {
        await sql.raw(`CREATE TEMPORARY VIEW ${quote(PROBE_NAME)} AS\n${body}`).execute(q);
        return {
          expected: await readPgViewColumns(q, `pg_temp.${quote(PROBE_NAME)}`),
          live: await readPgViewColumns(
            q,
            `${quote(live.schema ?? DEFAULT_DB_SCHEMA_POSTGRES)}.${quote(live.name)}`,
          ),
        };
      });
    } catch {
      return undefined;
    }
  };
}
