// shadow-canon.ts — the primary Postgres answer to "how does Postgres spell this?".
//
// The practice Atlas, Prisma and migra share: apply the model's full expected schema to a
// scratch (shadow) database, introspect it with the very introspector that reads the live
// database, and diff the two catalogs (shadow-expected.ts). Both sides are then Postgres's own
// spelling of the same catalog, so no per-shape rule is needed for anything in scope.
//
// The DDL is the one `meta migrate` emits for an empty database, run inside ONE transaction
// that is always rolled back, so nothing is left behind even in a shared shadow database.
// Each view is created under its own savepoint: a view whose body reads an object only the
// live database has is left out of the shadow (and compared by its fingerprint instead)
// without costing the run its table comparison.
//
// When the shadow cannot be opened or the tables do not apply to it (an FK to a table outside
// the run's scope, a missing extension), a `required` shadow (one the user configured) is an
// error naming the cause; otherwise the source answers `unavailable` with that cause and the
// caller falls back to the temp-object probe (expr-canon-probe.ts), then the string normaliser.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { diff } from "./diff/index.js";
import { emit } from "./emit/index.js";
import { introspectPostgres } from "./introspect/postgres.js";
import { qualifiedDbName } from "./qualified-name.js";
import type { ExprCanon, ExprCanonProbe, IndexExprCanon } from "./expr-canon.js";
import type { ShadowCatalog, ShadowSchemaSource } from "./shadow-expected.js";
import type { CheckDescriptor, ColumnDefault, ColumnDescriptor, IndexDescriptor, SchemaSnapshot } from "./types.js";

/** A connection to a scratch Postgres database, and how to release it. */
export interface ShadowHandle {
  db: Kysely<Record<string, unknown>>;
  /** Release the connection and drop the database if the opener created it. Must not throw. */
  close(): Promise<void>;
}

/** Opens a shadow database. A rejection means none could be opened; its message is the reason. */
export type ShadowOpener = () => Promise<ShadowHandle>;

const ROLLBACK = new Error("shadow canon: always rolled back");
const VIEW_SAVEPOINT = "mo_shadow_view";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The shadow catalog for a run: `expected` applied to a scratch database and introspected.
 * `required`: the shadow was configured explicitly, so a failure throws instead of falling back.
 */
export function postgresShadowSchema(open: ShadowOpener, opts: { required?: boolean } = {}): ShadowSchemaSource {
  const unavailable = (reason: string): ShadowCatalog => {
    if (opts.required === true) throw new Error(`shadow database: ${reason}`);
    return { unavailable: reason };
  };
  return async (expected) => {
    let handle: ShadowHandle;
    try {
      handle = await open();
    } catch (err) {
      return unavailable(`could not be opened: ${messageOf(err)}`);
    }
    try {
      const { changes } = await diff({ expected, actual: { tables: [], views: [] }, dialect: "postgres" });
      const views = changes.filter((c) => c.kind === "create-view");
      const { up } = emit(changes.filter((c) => c.kind !== "create-view"), { dialect: "postgres" });
      let shadow: SchemaSnapshot | undefined;
      try {
        await handle.db.transaction().execute(async (trx) => {
          await sql.raw(up).execute(trx);
          for (const view of views) {
            await sql.raw(`SAVEPOINT ${VIEW_SAVEPOINT}`).execute(trx);
            try {
              await sql.raw(emit([view], { dialect: "postgres" }).up).execute(trx);
              await sql.raw(`RELEASE SAVEPOINT ${VIEW_SAVEPOINT}`).execute(trx);
            } catch {
              await sql.raw(`ROLLBACK TO SAVEPOINT ${VIEW_SAVEPOINT}`).execute(trx);
            }
          }
          shadow = await introspectPostgres(trx as unknown as Kysely<Record<string, unknown>>);
          throw ROLLBACK;
        });
      } catch (err) {
        if (err !== ROLLBACK) throw err;
      }
      return { catalog: shadow! };
    } catch (err) {
      return unavailable(`the expected schema does not apply to it: ${messageOf(err)}`);
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
