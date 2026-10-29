// shadow.ts — where the Postgres scratch (shadow) database comes from.
//
// `meta verify --db` and `meta migrate --from-db` apply the model's expected schema to a
// scratch database and compare it with the live one in Postgres's own spelling
// (migrate-ts shadow-canon.ts). Three sources, in order:
//   1. an explicit URL (`--shadow-db`, `SHADOW_DATABASE_URL`, `migrate.shadowDatabaseUrl`),
//      used as given and never dropped (the expected schema is applied in a transaction that
//      is rolled back, so nothing is left in it);
//   2. a database CREATEd on the target server when the role may, named per run and always
//      dropped afterwards, including on error;
//   3. none: the caller falls back to the temp-object probe.
// `--no-shadow-db` skips straight to 3.

import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { ShadowHandle, ShadowOpener } from "@metaobjectsdev/migrate-ts";
import { buildKyselyFromUrl, type KyselyHandle } from "./kysely.js";

export interface ShadowSettings {
  /** Explicit scratch database URL, or undefined to create one on the target server. */
  url: string | undefined;
  /** `--no-shadow-db`. */
  disabled: boolean;
}

/** The URL of database `name` on the same server as `targetUrl` (same credentials and options). */
export function urlForDatabase(targetUrl: string, name: string): string {
  const u = new URL(targetUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * The opener for a Postgres target, or `undefined` when scratch databases are switched off.
 * `target` is the already-open connection to the live database, used for CREATE/DROP DATABASE.
 */
export function shadowOpener(
  settings: ShadowSettings,
  target: { url: string; handle: KyselyHandle },
): ShadowOpener | undefined {
  if (settings.disabled) return undefined;
  if (settings.url !== undefined) {
    const explicit = settings.url;
    return async (): Promise<ShadowHandle> => {
      const h = await buildKyselyFromUrl(explicit, "postgres");
      return { db: h.db, close: async () => { await h.close(); } };
    };
  }
  return async (): Promise<ShadowHandle> => {
    const name = `mo_shadow_${randomBytes(6).toString("hex")}`;
    await sql.raw(`CREATE DATABASE ${quoteIdent(name)}`).execute(target.handle.db);
    let h: KyselyHandle | undefined;
    const drop = async (): Promise<void> => {
      try { await h?.close(); } catch { /* the drop below is what matters */ }
      try {
        await sql.raw(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).execute(target.handle.db);
      } catch {
        // Before Postgres 13 there is no WITH (FORCE); our own connection is closed by now.
        try { await sql.raw(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`).execute(target.handle.db); } catch { /* best effort */ }
      }
    };
    try {
      h = await buildKyselyFromUrl(urlForDatabase(target.url, name), "postgres");
    } catch (err) {
      await drop();
      throw err;
    }
    const opened = h;
    return { db: opened.db, close: drop };
  };
}

/** One line saying which comparison decided CHECK, index-expression and column-default equality. */
export function describeExprCanonPath(path: "shadow" | "probe" | "normaliser"): string {
  switch (path) {
    case "shadow":
      return "Postgres expressions compared against a scratch (shadow) database.";
    case "probe":
      return "Postgres expressions compared via the temp-object probe on the target database (no scratch database was "
        + "available): it needs write privileges and takes brief locks on the target. Pass --shadow-db <url> to avoid that.";
    case "normaliser":
      return "Postgres expressions compared as text (no scratch database or probe was available); a re-spelled "
        + "CHECK, index expression or default may read as drift.";
  }
}
