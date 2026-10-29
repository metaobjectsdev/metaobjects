// shadow-canon.ts — the primary Postgres answer to "how does Postgres spell this?".
//
// The practice Atlas, Prisma and migra share: apply the model's full expected schema to a
// scratch (shadow) database, introspect it with the very introspector that reads the live
// database, and diff the two catalogs (shadow-expected.ts). Both sides are then Postgres's own
// spelling of the same catalog, so no per-shape rule is needed for anything in scope.
//
// The DDL is the one `meta migrate` emits for an empty database, run inside ONE transaction
// that is always rolled back, so nothing is left behind even in a shared shadow database.
// Where no shadow database can be opened, or the schema does not apply to it (an FK to a
// table outside the run's scope, a missing extension), the caller falls back to the
// temp-object probe (expr-canon-probe.ts), and from there to the string normaliser.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { diff } from "./diff/index.js";
import { emit } from "./emit/index.js";
import { introspectPostgres } from "./introspect/postgres.js";
import { qualifiedDbName } from "./qualified-name.js";
import type { ExprCanon, ExprCanonProbe, IndexExprCanon } from "./expr-canon.js";
import type { ShadowSchemaSource } from "./shadow-expected.js";
import type { CheckDescriptor, ColumnDefault, ColumnDescriptor, IndexDescriptor, SchemaSnapshot } from "./types.js";

/** A connection to a scratch Postgres database, and how to release it. */
export interface ShadowHandle {
  db: Kysely<Record<string, unknown>>;
  /** Release the connection and drop the database if the opener created it. Must not throw. */
  close(): Promise<void>;
}

/** Opens a shadow database, or resolves `undefined` when none is available. May throw; that reads as unavailable. */
export type ShadowOpener = () => Promise<ShadowHandle | undefined>;


const ROLLBACK = new Error("shadow canon: always rolled back");

/**
 * The shadow catalog for a run: `expected` applied to a scratch database and introspected, or
 * `undefined` when no shadow is available or the schema does not apply (the caller falls back).
 */
export function postgresShadowSchema(open: ShadowOpener): ShadowSchemaSource {
  return async (expected) => {
    let handle: ShadowHandle | undefined;
    try {
      handle = await open();
    } catch {
      return undefined;
    }
    if (handle === undefined) return undefined;
    try {
      const { changes } = await diff({ expected, actual: { tables: [], views: [] }, dialect: "postgres" });
      const { up } = emit(changes, { dialect: "postgres" });
      let shadow: SchemaSnapshot | undefined;
      try {
        await handle.db.transaction().execute(async (trx) => {
          await sql.raw(up).execute(trx);
          shadow = await introspectPostgres(trx as unknown as Kysely<Record<string, unknown>>);
          throw ROLLBACK;
        });
      } catch (err) {
        if (err !== ROLLBACK) return undefined;
      }
      return shadow;
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  };
}

/** An {@link ExprCanonProbe} reading each expected descriptor off the shadow table of the same name (used by `baseline --from-db`). */
export function canonProbeOverShadow(shadow: SchemaSnapshot): ExprCanonProbe {
  const tables = new Map(shadow.tables.map((t) => [qualifiedDbName(t), t] as const));
  return async (_live, expected) => {
    const st = tables.get(qualifiedDbName(expected));
    if (st === undefined) return undefined;
    const checks = new Map<CheckDescriptor, string>();
    for (const c of expected.checks) {
      const s = st.checks.find((x) => x.name === c.name);
      if (s !== undefined) checks.set(c, s.expression);
    }
    const indexes = new Map<IndexDescriptor, IndexExprCanon>();
    for (const ix of expected.indexes) {
      const s = st.indexes.find((x) => x.name === ix.name);
      if (s === undefined) continue;
      const canon: IndexExprCanon = {};
      if (ix.expr !== undefined && s.expr !== undefined) canon.expr = s.expr;
      if (ix.where !== undefined && s.where !== undefined) canon.where = s.where;
      indexes.set(ix, canon);
    }
    const defaults = new Map<ColumnDescriptor, ColumnDefault>();
    for (const col of expected.columns) {
      const d = st.columns.find((x) => x.name === col.name)?.default;
      if (col.default !== undefined && d !== undefined) defaults.set(col, d);
    }
    const answer: ExprCanon = { checks, indexes, defaults };
    return answer;
  };
}
