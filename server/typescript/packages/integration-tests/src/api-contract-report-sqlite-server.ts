// api-contract-report-sqlite-server.ts — boots the GENERATED report routes on SQLite
// (bun:sqlite) and drives them over HTTP. The Postgres twin is
// api-contract-report-generated-server.ts; this one exists because the TypeScript view
// read schema types a ratio (a decimal) as a string, SQLite has no decimal and returns a
// REAL, and the corpus runs TypeScript on Postgres only. What the route answers for a
// ratio there is gated by test/api-contract-report-sqlite.test.ts.
//
// Same shape as the Postgres server: run the real codegen over report/meta.json
// (dialect sqlite), provision `invoices` by hand in the EMITTED snake_case spelling,
// create each view from buildReportViews (the real lowering), import the EMITTED
// <Report>.routes.ts files unmodified and mount them.

import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig, buildReportViews } from "@metaobjectsdev/codegen-ts";
import { DEFAULT_COLUMN_NAMING_STRATEGY } from "@metaobjectsdev/metadata";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import { loadMetadataFile } from "./load-metadata.ts";
import type { ReportSeed } from "./api-contract-report-generated-server.ts";

export interface SqliteReportServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

const SERVED_REPORTS = [
  { name: "InvoiceStatusTotals", registrar: "invoiceStatusTotalsRoutes" },
  { name: "InvoicesByMonth", registrar: "invoicesByMonthRoutes" },
  { name: "InvoiceTotals", registrar: "invoiceTotalsRoutes" },
] as const;

export async function startSqliteReportServer(metaPath: string): Promise<SqliteReportServerHandle> {
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
      dialect: "sqlite",
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

  // The emitted routes import `db` from "./db"; one in-memory database serves them and the
  // seed. A REAL read back from SQLite is the same JS number on every SQLite driver.
  const dbModule = `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
export const client = new Database(":memory:");
export const db = drizzle(client);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { client: Database };

  const views = buildReportViews(root, {
    dialect: "sqlite",
    columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY,
  });
  dbMod.client.run(`
    CREATE TABLE "invoices" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "reference" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "amount_cents" INTEGER NOT NULL,
      "issued_on" TEXT NOT NULL
    )`);
  for (const v of views) {
    if (v.sql === undefined) throw new Error(`view ${v.name} has no SQL`);
    dbMod.client.run(`CREATE VIEW "${v.name}" AS ${v.sql}`);
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
      dbMod.client.run(`DELETE FROM "invoices"`);
      for (const i of seed.invoices) {
        dbMod.client.run(
          `INSERT INTO "invoices" ("id","reference","status","amount_cents","issued_on") VALUES (?,?,?,?,?)`,
          [i.id, i.reference, i.status, i.amountCents, i.issuedOn],
        );
      }
    },
    close: async () => {
      await fastify.close();
      dbMod.client.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
