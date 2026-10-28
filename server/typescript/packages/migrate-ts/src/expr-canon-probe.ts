// expr-canon-probe.ts — the Postgres implementation of the expression-canon probe (see
// expr-canon.ts for why the planner asks the database instead of predicting).
//
// For one live table it creates a TEMPORARY table with the same columns, adds each expected
// CHECK to it and each expected index expression / predicate as a temporary index, reads
// back what Postgres stored, and rolls everything back. Nothing persists, and nothing is
// ever written to the live table.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
import { indexDefKeyExpr } from "./introspect/postgres.js";
import { stripCheckWrapper } from "./check-expr-compare.js";
import type { ExprCanon, ExprCanonProbe, IndexExprCanon } from "./expr-canon.js";
import type { CheckDescriptor, IndexDescriptor } from "./types.js";
import { quote, rolledBack } from "./view-replace-probe.js";

const TABLE = "mo_check_probe";
const CONSTRAINT = "mo_check_probe_c";
const INDEX = "mo_check_probe_i";
const SAVEPOINT = "mo_check_probe_sp";

/** SQLSTATEs that mean no table will ever probe on this connection: read-only, no TEMP privilege. */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set(["25006", "42501"]);

/**
 * True when `text` holds a `;` outside a quoted literal or identifier. The probe runs an
 * author's expression inside DDL over the simple query protocol, where a second statement
 * would run too; a verify run must not execute one, so such an expression is not probed
 * (it falls back to the string comparison).
 */
function hasStatementSeparator(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const quoteChar = ch;
      i++;
      while (i < text.length && !(text[i] === quoteChar && text[i + 1] !== quoteChar)) i += text[i] === quoteChar ? 2 : 1;
    } else if (ch === ";") return true;
  }
  return false;
}

/** Run `work` inside a savepoint it always rolls back, resolving `undefined` when it throws. */
async function attempt<T>(
  q: Kysely<Record<string, unknown>>,
  work: () => Promise<T>,
): Promise<T | undefined> {
  await sql.raw(`SAVEPOINT ${SAVEPOINT}`).execute(q);
  try {
    return await work();
  } catch {
    return undefined;
  } finally {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).execute(q);
    await sql.raw(`RELEASE SAVEPOINT ${SAVEPOINT}`).execute(q);
  }
}

function indexKeys(ix: IndexDescriptor): string {
  return ix.expr ?? ix.columns.map((c, i) => (ix.orders?.[i] === "desc" ? `${quote(c)} DESC` : quote(c))).join(", ");
}

/**
 * The probe for a live Postgres database. A table it cannot probe, or an expression that
 * does not compile against that table's live columns, simply has no entry in the answer.
 */
export function postgresExprCanonProbe(db: Kysely<Record<string, unknown>>): ExprCanonProbe {
  // Set once the server refuses a scratch table outright, so a read-only standby is asked
  // once rather than once per table.
  let unavailable = false;
  return async (live, expected) => {
    if (unavailable) return undefined;
    const checks = expected.checks.filter((c) => !hasStatementSeparator(c.expression));
    const indexes = expected.indexes.filter(
      (ix) => (ix.expr !== undefined || ix.where !== undefined)
        && !hasStatementSeparator(ix.expr ?? "") && !hasStatementSeparator(ix.where ?? ""),
    );
    if (checks.length === 0 && indexes.length === 0) return undefined;
    const liveTable = `${quote(live.schema ?? DEFAULT_DB_SCHEMA_POSTGRES)}.${quote(live.name)}`;
    const scratch = `pg_temp.${quote(TABLE)}`;
    try {
      return await rolledBack(db, async (q): Promise<ExprCanon> => {
        try {
          await sql.raw(`CREATE TEMPORARY TABLE ${quote(TABLE)} (LIKE ${liveTable})`).execute(q);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (typeof code === "string" && UNAVAILABLE_SQLSTATES.has(code)) unavailable = true;
          throw err;
        }
        const checkAnswers = new Map<CheckDescriptor, string>();
        for (const check of checks) {
          const def = await attempt(q, async () => {
            await sql.raw(`ALTER TABLE ${scratch} ADD CONSTRAINT ${quote(CONSTRAINT)} CHECK (${check.expression})`).execute(q);
            const rows = await sql<{ def: string }>`
              SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
              WHERE conrelid = ${scratch}::regclass AND conname = ${CONSTRAINT}
            `.execute(q);
            return rows.rows[0]?.def;
          });
          if (def !== undefined) checkAnswers.set(check, stripCheckWrapper(def));
        }
        const indexAnswers = new Map<IndexDescriptor, IndexExprCanon>();
        for (const ix of indexes) {
          const using = ix.using && ix.using !== "btree" ? ` USING ${ix.using}` : "";
          const where = ix.where !== undefined ? ` WHERE (${ix.where})` : "";
          const stored = await attempt(q, async () => {
            await sql.raw(`CREATE INDEX ${quote(INDEX)} ON ${scratch}${using} (${indexKeys(ix)})${where}`).execute(q);
            const rows = await sql<{ def: string; predicate: string | null }>`
              SELECT pg_get_indexdef(indexrelid) AS def, pg_get_expr(indpred, indrelid) AS predicate
              FROM pg_index WHERE indexrelid = ${`pg_temp.${quote(INDEX)}`}::regclass
            `.execute(q);
            return rows.rows[0];
          });
          if (stored === undefined) continue;
          const canon: IndexExprCanon = {};
          if (ix.expr !== undefined) canon.expr = indexDefKeyExpr(stored.def);
          if (ix.where !== undefined && stored.predicate !== null) canon.where = stored.predicate;
          indexAnswers.set(ix, canon);
        }
        return { checks: checkAnswers, indexes: indexAnswers };
      });
    } catch {
      return undefined;
    }
  };
}
