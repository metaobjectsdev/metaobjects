// shadow.ts — where the Postgres scratch (shadow) database comes from.
//
// `meta verify --db`, `meta migrate --from-db` and `meta migrate baseline --from-db` apply the
// model's expected schema to a scratch database and compare it with the live one in
// Postgres's own spelling (migrate-ts shadow-canon.ts). Sources, in order:
//   1. an explicit URL (`--shadow-db`, `SHADOW_DATABASE_URL`, `migrate.shadowDatabaseUrl`),
//      used as given and never dropped (the expected schema is applied in a transaction that
//      is rolled back, so nothing is left in it). One that cannot be used is an error;
//   2. a database CREATEd on the target server when the role may, named per run and always
//      dropped afterwards, including on error;
//   3. none: the caller falls back to the temp-object probe, and says why.
// A run opens its scratch database once, however many comparisons it makes.

import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { postgresShadowSchema, type ExprCanonPath, type ShadowHandle, type ShadowOpener, type ShadowSchemaSource } from "@metaobjectsdev/migrate-ts";
import { buildKyselyFromUrl, redactUrl, type KyselyHandle } from "./kysely.js";

/** The URL of database `name` on the same server as `targetUrl` (same credentials and options). */
export function urlForDatabase(targetUrl: string, name: string): string {
  const u = new URL(targetUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Connect to `url`, proving the connection with a round trip (a Kysely pool connects lazily). */
async function connect(url: string): Promise<KyselyHandle> {
  const h = await buildKyselyFromUrl(url, "postgres");
  try {
    await sql`SELECT 1`.execute(h.db);
  } catch (err) {
    try { await h.close(); } catch { /* the connection error is what matters */ }
    throw err;
  }
  return h;
}

/**
 * Opens the scratch database for a Postgres target. `url` is the explicit setting, if any;
 * `targetUrl` is the live database, on whose server a database is CREATEd otherwise. CREATE
 * and DROP DATABASE run on a connection of the opener's own, so the drop does not depend on
 * the caller's connection to the target still being open.
 */
export function shadowOpener(url: string | undefined, targetUrl: string): ShadowOpener {
  if (url !== undefined) {
    return async (): Promise<ShadowHandle> => {
      let h: KyselyHandle;
      try {
        h = await connect(url);
      } catch (err) {
        throw new Error(`${redactUrl(url)}: ${messageOf(err)}`);
      }
      return { db: h.db, close: async () => { await h.close(); } };
    };
  }
  return async (): Promise<ShadowHandle> => {
    const name = `mo_shadow_${randomBytes(6).toString("hex")}`;
    const admin = await connect(targetUrl);
    try {
      await sql.raw(`CREATE DATABASE ${quoteIdent(name)}`).execute(admin.db);
    } catch (err) {
      try { await admin.close(); } catch { /* the refusal is what matters */ }
      throw new Error(`CREATE DATABASE on the --db server failed: ${messageOf(err)}`);
    }
    let h: KyselyHandle | undefined;
    const drop = async (): Promise<void> => {
      try { await h?.close(); } catch { /* the drop below is what matters */ }
      try {
        await sql.raw(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).execute(admin.db);
      } catch {
        // Before Postgres 13 there is no WITH (FORCE); our own connection is closed by now.
        try { await sql.raw(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`).execute(admin.db); } catch { /* best effort */ }
      }
      try { await admin.close(); } catch { /* the database is gone; nothing else to release */ }
    };
    try {
      h = await connect(urlForDatabase(targetUrl, name));
    } catch (err) {
      await drop();
      throw err;
    }
    const opened = h;
    return { db: opened.db, close: drop };
  };
}

/** One run's scratch database: opened on first use, shared by every comparison, released by `close`. */
export interface ShadowSession {
  schema: ShadowSchemaSource;
  /** Drop the database if this run created it. Never throws. */
  close(): Promise<void>;
}

export function shadowSession(url: string | undefined, targetUrl: string): ShadowSession {
  const open = shadowOpener(url, targetUrl);
  let opened: Promise<ShadowHandle> | undefined;
  const shared: ShadowOpener = async () => {
    opened ??= open();
    const h = await opened;
    return { db: h.db, close: async () => {} };
  };
  return {
    schema: postgresShadowSchema(shared, { required: url !== undefined }),
    close: async () => {
      if (opened === undefined) return;
      try { await (await opened).close(); } catch { /* it never opened */ }
    },
  };
}

/** One line saying which comparison decided Postgres drift, and why a scratch database was not used. */
export function describeExprCanonPath(path: ExprCanonPath, shadowUnavailable?: string): string {
  const why = shadowUnavailable !== undefined ? ` The scratch database was not used: ${shadowUnavailable}.` : "";
  switch (path) {
    case "shadow":
      return "Postgres drift compared against a scratch (shadow) database.";
    case "probe":
      return "Postgres expressions compared via the temp-object probe on the target database (no scratch database was "
        + `available): it needs write privileges and takes brief locks on the target. Pass --shadow-db <url> to avoid that.${why}`;
    case "normaliser":
      return "Postgres expressions compared as text (no scratch database or probe was available); a re-spelled "
        + `CHECK, index expression or default may read as drift.${why}`;
  }
}
