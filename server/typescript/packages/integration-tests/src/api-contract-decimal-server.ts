// api-contract-decimal-server.ts — boots the GENERATED routes of the decimal sub-corpus
// (api-contract-conformance/decimal/) on Postgres, MySQL, SQLite and Cloudflare D1's local runtime
// and drives them over HTTP (ADR-0019 Amendment 1).
//
// The model is one writable entity (`Entry`, a decimal(28,10) `amount`) and one served report
// (`EntryTotals`, whose measures are decimal sums, an average, a maximum and two ratios). The
// server runs the real codegen over decimal/meta.json for the engine's dialect, executes the
// COMMITTED schema artifact for that engine (the table and the view the real lowering produces),
// imports each EMITTED <Object>.routes.ts unmodified and mounts it. Nothing is hand-rolled
// between the HTTP request and the database, which is the point: the wire rule is a property of
// the deployed artifact.

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import mysql from "mysql2/promise";
import pg from "pg";
import { startLocalD1 } from "./query-scenario-d1.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import { seedInserts, type ReportSeed } from "./api-contract-report-generated-server.ts";
import {
  API_CONTRACT_DECIMAL_MYSQL_SCHEMA_SQL_PATH,
  API_CONTRACT_DECIMAL_SCHEMA_SQL_PATH,
  API_CONTRACT_DECIMAL_SQLITE_SCHEMA_SQL_PATH,
} from "./paths.ts";
import { splitStatements } from "./sql-script.ts";

export type DecimalEngine = "postgres" | "mysql" | "sqlite" | "d1";

/** The served objects: the emitted routes file and the route the corpus calls. */
const SERVED = ["Entry", "EntryTotals", "Sample"] as const;

/** The tables the seed fills (and resets), in the order they are emptied. */
const TABLES = ["entries", "samples"] as const;

export interface DecimalServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

interface EngineClient {
  /** Run one statement; `?` placeholders (translated to `$n` on Postgres). */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Make the next generated id follow the highest explicit one (Postgres identity does not). */
  afterSeed(): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA_PATH: Record<DecimalEngine, string> = {
  postgres: API_CONTRACT_DECIMAL_SCHEMA_SQL_PATH,
  mysql: API_CONTRACT_DECIMAL_MYSQL_SCHEMA_SQL_PATH,
  sqlite: API_CONTRACT_DECIMAL_SQLITE_SCHEMA_SQL_PATH,
  d1: API_CONTRACT_DECIMAL_SQLITE_SCHEMA_SQL_PATH,
};

export async function startDecimalServer(
  engine: DecimalEngine,
  metaPath: string,
  /** The Postgres or MySQL connection URL; unused by SQLite and D1. */
  connectionUrl?: string,
): Promise<DecimalServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, `api-contract-decimal-${engine}-`));
  const fail = (message: string): never => {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(message);
  };

  // The root carries the corpus's literal naming (the nearest .metaobjects/config.json), the
  // spelling the committed schema artifact uses, so the emitted tables read it unmodified.
  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: engine === "d1" ? "sqlite" : engine, // codegen has no d1 dialect: D1 is SQLite to Drizzle
      apiPrefix: "/api",
      generators: [entityFile(), routesFile()],
    }),
    metadata: root,
  });
  for (const name of SERVED) if (!existsSync(join(tmp, `${name}.routes.ts`))) fail(`codegen emitted no ${name}.routes.ts`);
  if (lr.warnings.length > 0) fail(`codegen produced warnings: ${lr.warnings.join("; ")}`);

  const client = await openEngine(engine, tmp, connectionUrl);
  for (const stmt of splitStatements(readFileSync(SCHEMA_PATH[engine], "utf8"))) await client.run(stmt);

  const fastify = Fastify();
  for (const name of SERVED) {
    const mod = (await import(pathToFileURL(join(tmp, `${name}.routes.ts`)).href)) as Record<string, unknown>;
    const registrar = Object.values(mod).find((v): v is (f: FastifyInstance) => Promise<void> => typeof v === "function");
    if (registrar === undefined) fail(`${name}.routes.ts exports no registrar`);
    await fastify.register(registrar!);
  }
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ReportSeed) => {
      for (const table of TABLES) {
        await client.run(engine === "postgres" ? `TRUNCATE TABLE "${table}" RESTART IDENTITY` : engine === "mysql" ? `TRUNCATE TABLE \`${table}\`` : `DELETE FROM "${table}"`);
      }
      for (const r of seedInserts(root, seed)) {
        const q = engine === "mysql" ? "`" : '"';
        await client.run(
          `INSERT INTO ${q}${r.table}${q} (${r.columns.map((c) => `${q}${c}${q}`).join(",")}) ` +
            `VALUES (${r.columns.map(() => "?").join(",")})`,
          r.values,
        );
      }
      await client.afterSeed();
    },
    close: async () => {
      await fastify.close();
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Write the `db` module the emitted routes import and open the engine behind it. */
async function openEngine(engine: DecimalEngine, tmp: string, url: string | undefined): Promise<EngineClient> {
  if (engine === "postgres") {
    if (url === undefined) throw new Error("postgres needs a connection URL");
    const bigintTypes = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "pg-bigint-number-types.ts")).href;
    writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypes)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(url)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`, "utf8");
    const mod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };
    const admin = new pg.Pool({ connectionString: url });
    return {
      run: async (sql, params = []) => {
        let n = 0;
        await admin.query(sql.replace(/\?/g, () => `$${++n}`), params);
      },
      afterSeed: async () => {
        // An empty table must hand out id 1 next (is_called false); a seeded one continues after its highest id.
        for (const table of TABLES) {
          await admin.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT COALESCE(MAX("id"), 1) FROM "${table}"), (SELECT COUNT(*) > 0 FROM "${table}"))`);
        }
      },
      close: async () => { await mod.pool.end(); await admin.end(); },
    };
  }
  if (engine === "mysql") {
    if (url === undefined) throw new Error("mysql needs a connection URL");
    writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2";
export const pool = createPool({ uri: ${JSON.stringify(url)}, timezone: "Z", supportBigNumbers: true });
export const db = drizzle(pool);
`, "utf8");
    const mod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: { end(cb: () => void): void } };
    const admin = await mysql.createConnection({ uri: url, timezone: "Z" });
    // A previous server on this database may have left the objects behind.
    await admin.query("DROP VIEW IF EXISTS `v_entry_totals`");
    await admin.query("DROP TABLE IF EXISTS `entries`");
    await admin.query("DROP TABLE IF EXISTS `samples`");
    return {
      run: async (sql, params = []) => { await admin.query(sql, params); },
      afterSeed: async () => {},
      close: async () => {
        await new Promise<void>((done) => mod.pool.end(done));
        await admin.query("DROP VIEW IF EXISTS `v_entry_totals`");
        await admin.query("DROP TABLE IF EXISTS `entries`");
        await admin.query("DROP TABLE IF EXISTS `samples`");
        await admin.end();
      },
    };
  }
  if (engine === "d1") {
    const local = await startLocalD1();
    // One key per server, so two servers in flight never read each other's binding.
    const key = `__decimalD1_${randomUUID().replaceAll("-", "")}`;
    (globalThis as Record<string, unknown>)[key] = local.d1;
    writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/d1";
export const db = drizzle((globalThis as Record<string, never>)[${JSON.stringify(key)}]);
`, "utf8");
    return {
      run: async (sql, params = []) => { await local.d1.prepare(sql).bind(...params).all(); },
      afterSeed: async () => {},
      close: async () => { delete (globalThis as Record<string, unknown>)[key]; await local.dispose(); },
    };
  }
  writeFileSync(join(tmp, "db.ts"), `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
export const client = new Database(":memory:");
export const db = drizzle(client);
`, "utf8");
  const mod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { client: import("bun:sqlite").Database };
  return {
    run: async (sql, params = []) => { mod.client.run(sql, params as never); },
    afterSeed: async () => {},
    close: async () => { mod.client.close(); },
  };
}
