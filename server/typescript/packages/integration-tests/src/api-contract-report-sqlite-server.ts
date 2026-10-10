// api-contract-report-sqlite-server.ts — boots the GENERATED report routes on SQLite
// (bun:sqlite), or on Cloudflare D1's local runtime (Miniflare, `engine: "d1"`), and drives
// them over HTTP. The Postgres twin is
// api-contract-report-generated-server.ts; this one exists because the TypeScript view
// read schema types a ratio (a decimal) as a string, SQLite has no decimal and returns a
// REAL, and the corpus runs TypeScript on Postgres only. What the route answers for a
// ratio there is gated by test/api-contract-report-sqlite.test.ts.
//
// Same shape as the Postgres server: run the real codegen over report/meta.json
// (dialect sqlite), provision the base tables by hand in the EMITTED snake_case
// spelling, create each view from buildReportViews (the real lowering), import the
// EMITTED <Report>.routes.ts files unmodified and mount them.

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig, buildReportViews } from "@metaobjectsdev/codegen-ts";
import { DEFAULT_COLUMN_NAMING_STRATEGY } from "@metaobjectsdev/metadata";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import { loadMetadataFile } from "./load-metadata.ts";
import { seedInserts, type ReportSeed } from "./api-contract-report-generated-server.ts";
import { startLocalD1 } from "./query-scenario-d1.ts";

/** The SQLite-family engines this server runs the emitted routes on. */
export type SqliteReportEngine = "sqlite" | "d1";

/** What the server needs of an engine: run one statement, and close. */
interface EngineClient {
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteReportServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

const SERVED_REPORTS = [
  { name: "InvoiceStatusTotals", registrar: "invoiceStatusTotalsRoutes" },
  { name: "InvoicesByMonth", registrar: "invoicesByMonthRoutes" },
  { name: "InvoiceTotals", registrar: "invoiceTotalsRoutes" },
  { name: "ProductRevenue", registrar: "productRevenueRoutes" },
] as const;

/** The base tables, parents first, in the EMITTED snake_case spelling. */
const BASE_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: "invoices",
    ddl: `
    CREATE TABLE "invoices" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "reference" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "amount_cents" INTEGER NOT NULL,
      "issued_on" TEXT NOT NULL
    )`,
  },
  {
    name: "products",
    ddl: `
    CREATE TABLE "products" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL
    )`,
  },
  {
    name: "sales",
    ddl: `
    CREATE TABLE "sales" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "product_id" INTEGER NOT NULL REFERENCES "products" ("id"),
      "amount_cents" INTEGER NOT NULL
    )`,
  },
];

export async function startSqliteReportServer(
  metaPath: string,
  engine: SqliteReportEngine = "sqlite",
): Promise<SqliteReportServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-report-sqlite-"));

  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "sqlite", // codegen has no d1 dialect: D1 is SQLite to Drizzle (only the db module differs)
      apiPrefix: "/api",
      generators: [entityFile(), routesFile()],
    }),
    metadata: root,
  });
  if (existsSync(join(tmp, "InvoiceDays.routes.ts"))) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("codegen emitted a routes file for the sourceless report InvoiceDays");
  }
  if (lr.warnings.length > 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);
  }

  const client = await openEngine(engine, tmp);

  const views = buildReportViews(root, {
    dialect: "sqlite",
    columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY,
  });
  for (const t of BASE_TABLES) await client.run(t.ddl);
  for (const v of views) {
    if (v.sql === undefined) throw new Error(`view ${v.name} has no SQL`);
    await client.run(`CREATE VIEW "${v.name}" AS ${v.sql}`);
  }

  const fastify = Fastify();
  for (const r of SERVED_REPORTS) {
    const mod = (await import(pathToFileURL(join(tmp, `${r.name}.routes.ts`)).href)) as Record<
      string,
      (f: FastifyInstance) => Promise<void>
    >;
    const registrar = mod[r.registrar];
    if (registrar === undefined) throw new Error(`${r.name}.routes.ts does not export ${r.registrar}`);
    await fastify.register(registrar);
  }
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ReportSeed) => {
      // Children before parents on the way out; the seed's file order (parents first) on the way in.
      for (const t of [...BASE_TABLES].reverse()) await client.run(`DELETE FROM "${t.name}"`);
      for (const r of seedInserts(root, seed)) {
        await client.run(
          `INSERT INTO "${r.table}" (${r.columns.map((c) => `"${c}"`).join(",")}) ` +
            `VALUES (${r.columns.map(() => "?").join(",")})`,
          r.values,
        );
      }
    },
    close: async () => {
      await fastify.close();
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Write the `db` module the emitted routes import (`import { db } from "./db"`) and open the
 * engine behind it. One database serves the routes and the seed. A REAL read back from SQLite
 * is the same JS number on every SQLite driver. D1 runs in Miniflare; its binding is handed to
 * the module through `globalThis`, which is how a Worker's env binding reaches drizzle here.
 */
async function openEngine(engine: SqliteReportEngine, tmp: string): Promise<EngineClient> {
  if (engine === "d1") {
    const local = await startLocalD1();
    // One key per server, so two servers in flight never read each other's binding.
    const key = `__reportD1_${randomUUID().replaceAll("-", "")}`;
    (globalThis as Record<string, unknown>)[key] = local.d1;
    writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/d1";
export const db = drizzle((globalThis as Record<string, never>)[${JSON.stringify(key)}]);
`, "utf8");
    return {
      run: async (sql, params = []) => {
        await local.d1.prepare(sql).bind(...params).all();
      },
      close: async () => {
        delete (globalThis as Record<string, unknown>)[key];
        await local.dispose();
      },
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
    close: async () => { mod.client.close(); },
  };
}
