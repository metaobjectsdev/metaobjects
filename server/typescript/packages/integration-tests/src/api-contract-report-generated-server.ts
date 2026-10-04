// api-contract-report-generated-server.ts — boots the GENERATED report routes (the
// deployed artifact) over HTTP and drives them against the FR-044 report corpus.
//
// The model is one writable `Invoice` entity and four `object.report` nodes; three
// declare `source.rdb @kind:view` and are served, `InvoiceDays` declares no source and
// must emit nothing. It:
//   1. runs the real codegen (runGen) over report/meta.json into a temp dir and fails
//      if a routes file was emitted for the sourceless report;
//   2. provisions `invoices` by hand in the EMITTED snake_case spelling, then creates
//      each view from buildReportViews (the real lowering, the real view SQL) under
//      the emitted names, so the route reads through the real view;
//   3. imports the three EMITTED <Report>.routes.ts files unmodified and mounts them.
//
// Generated lane only, and on every port — see the corpus README.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig, buildReportViews } from "@metaobjectsdev/codegen-ts";
import { DEFAULT_COLUMN_NAMING_STRATEGY } from "@metaobjectsdev/metadata";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface ReportSeed {
  invoices: Array<{
    id: number;
    reference: string;
    status: string;
    amountCents: number;
    issuedOn: string;
  }>;
  reports?: Record<string, Array<Record<string, unknown>>>;
}

export interface GeneratedReportServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

/** The served reports: emitted registrar, and the route the corpus calls. */
const SERVED_REPORTS = [
  { name: "InvoiceStatusTotals", registrar: "invoiceStatusTotalsRoutes" },
  { name: "InvoicesByMonth", registrar: "invoicesByMonthRoutes" },
  { name: "InvoiceTotals", registrar: "invoiceTotalsRoutes" },
] as const;

export async function startGeneratedReportServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedReportServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-report-"));

  // 1. Emit the real artifacts for the report model.
  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "postgres",
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
    throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);
  }

  // 2. db module the emitted routes import (`import { db } from "./db"`).
  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  const dbModule = `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");

  // 3. Provision the base table (snake_case, the EMITTED Drizzle table's spelling) and
  //    each view from the real lowering under the same naming strategy.
  const views = buildReportViews(root, {
    dialect: "postgres",
    columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY,
  });
  const createViews = views
    .map((v) => {
      if (v.sql === undefined) throw new Error(`view ${v.name} has no SQL`);
      return `CREATE VIEW "${v.name}" AS ${v.sql};`;
    })
    .join("\n");
  await executeSql(connectionUri, `
    CREATE TABLE IF NOT EXISTS "invoices" (
      "id" bigserial PRIMARY KEY,
      "reference" varchar(40) NOT NULL,
      "status" varchar(20) NOT NULL,
      "amount_cents" bigint NOT NULL,
      "issued_on" date NOT NULL
    );
    ${createViews}
  `);

  // 4. Import the EMITTED route files unmodified and mount all three.
  const fastify = Fastify();
  for (const r of SERVED_REPORTS) {
    const mod = (await import(pathToFileURL(join(tmp, `${r.name}.routes.ts`)).href)) as Record<
      string,
      (f: FastifyInstance) => Promise<void>
    >;
    const registrar = mod[r.registrar];
    if (registrar === undefined) {
      throw new Error(`${r.name}.routes.ts does not export ${r.registrar}`);
    }
    await fastify.register(registrar);
  }
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ReportSeed) => {
      await seedReport(connectionUri, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Truncate + insert the base table. Only `invoices` is seeded; the views derive on read. */
export async function seedReport(connectionUri: string, seed: ReportSeed): Promise<void> {
  await executeSql(connectionUri, `TRUNCATE TABLE "invoices" RESTART IDENTITY CASCADE;`);
  for (const i of seed.invoices) {
    await executeSql(
      connectionUri,
      `INSERT INTO "invoices" ("id","reference","status","amount_cents","issued_on")
       VALUES (${i.id}, ${str(i.reference)}, ${str(i.status)}, ${i.amountCents}, ${str(i.issuedOn)})`,
    );
  }
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
