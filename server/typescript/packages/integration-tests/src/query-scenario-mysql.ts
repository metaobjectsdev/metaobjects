// query-scenario-mysql.ts — the persistence query scenarios on MySQL 8.4, through the
// ObjectManager's Kysely driver (MysqlDialect + mysql2). Same shape as the SQLite runner:
// execute the committed schema artifact, seed, run the shared DSL, hold the result to `expect`
// (or the query's `expect-engine` entry).
//
// The artifact is canonical/schema.mysql.sql: the adopter's tables plus the report views
// TypeScript lowers (buildReportViews, docs/recipes/mysql.md). The server keeps its default
// sql_mode, ONLY_FULL_GROUP_BY included — the view bodies must be valid under it.
//
// The corpus' seed is Postgres SQL with `"identifier"` quoting. MySQL quotes identifiers with
// backticks (ANSI_QUOTES would change how the VIEW bodies parse, so it stays off), so the seed
// is translated mechanically: identifier quotes become backticks, and an ISO instant's `Z`
// is dropped because DATETIME holds the UTC wall clock (the pool pins `timezone: "Z"`).

import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import mysql from "mysql2/promise";

import { splitStatements } from "./sql-script.ts";

export { splitStatements };

import { CANONICAL_COLUMN_NAMING } from "./canonical-schema.ts";
import { readCanonicalMysqlSchemaSql } from "./canonical-schema-mysql.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { runScenarioQueries } from "./query-scenario.ts";
import type { QueryScenario } from "./scenario.ts";

/**
 * Postgres-quoted seed SQL -> MySQL. Walks the text once so a `"` INSIDE a single-quoted
 * string (a JSON payload) is left alone, and only a double-quoted identifier is rewritten.
 */
export function toMysqlSeed(seed: string): string {
  let out = "";
  let inString = false;
  let inIdent = false;
  for (let i = 0; i < seed.length; i++) {
    const c = seed[i]!;
    if (inString) {
      out += c;
      if (c === "'") {
        if (seed[i + 1] === "'") { out += "'"; i++; } else inString = false;
      }
    } else if (inIdent) {
      if (c === '"') { out += "`"; inIdent = false; } else out += c;
    } else if (c === "'") {
      inString = true;
      out += c;
    } else if (c === '"') {
      inIdent = true;
      out += "`";
    } else {
      out += c;
    }
  }
  // '2026-05-04T03:30:00Z' -> '2026-05-04T03:30:00' (DATETIME is the UTC wall clock).
  return out.replace(/'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z'/g, "'$1'");
}

/** Every table and view the schema artifact creates, dropped first so a rerun starts clean. */
export async function resetSchema(conn: mysql.Connection, schemaSql: string): Promise<void> {
  const statements = splitStatements(schemaSql);
  const views = statements.flatMap((s) => /^CREATE VIEW `([^`]+)`/.exec(s)?.[1] ?? []);
  const tables = statements.flatMap((s) => /^CREATE TABLE `([^`]+)`/.exec(s)?.[1] ?? []);
  for (const v of views) await conn.query(`DROP VIEW IF EXISTS \`${v}\``);
  for (const t of [...tables].reverse()) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  for (const stmt of statements) await conn.query(stmt);
}

export async function runQueryScenarioMysql(
  scenario: QueryScenario,
  mysqlUrl: string,
  canonicalDir: string,
): Promise<void> {
  const admin = await mysql.createConnection({ uri: mysqlUrl, timezone: "Z" });
  // The pool is the runtime's: BIGINT and DECIMAL as text (a JS number cannot hold a BIGINT),
  // DATE / DATETIME as the text MySQL sent rather than a Date shifted by the host zone.
  const pool = createPool({
    uri: mysqlUrl, timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  const kysely = new Kysely<Record<string, never>>({ dialect: new MysqlDialect({ pool }) });
  try {
    await resetSchema(admin, readCanonicalMysqlSchemaSql());
    const seed = scenario.seedDataEngine?.mysql ?? (scenario.seedData ? toMysqlSeed(scenario.seedData) : "");
    for (const stmt of splitStatements(seed)) await admin.query(stmt);

    const root = await loadMetadataDir(canonicalDir);
    const driver = kyselyDriver({ db: kysely as never, dialect: "mysql" });
    const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: CANONICAL_COLUMN_NAMING });
    await runScenarioQueries(scenario, om, root, "mysql");
  } finally {
    await kysely.destroy();
    await admin.end();
  }
}
