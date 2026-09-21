// api-contract-projection-generated-server.ts — boots the GENERATED
// InvoiceSummary routes (the deployed artifact) over HTTP and drives them
// against the F22 projection corpus.
//
// The model is a VIEW-ONLY `object.projection`: InvoiceSummary's only source is
// `source.rdb @kind:view @view:v_invoice_summary`, beside the writable `Invoice`
// table it projects. It:
//   1. runs the real codegen (runGen) over the projection meta into a temp dir,
//      emitting Invoice's Drizzle table, the `.existing()` VIEW binding for
//      v_invoice_summary, and InvoiceSummary.routes.ts — which mounts
//      mountReadOnlyCrudRoutes (GET list + GET :id, writes 405);
//   2. provisions the `invoices` table AND the `v_invoice_summary` SQL view the
//      generated binding reads through;
//   3. imports the EMITTED InvoiceSummary.routes.ts unmodified and mounts it.
//
// Generated lane only, and on every port — see the corpus README. The thing
// under test is whether a port's GENERATOR emits routes for a view-only
// projection at all; a hand-rolled reference server would answer every scenario
// by construction and prove nothing about the emitted artifact.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface ProjectionSeed {
  invoices: Array<{ id: number; reference: string; status: string; amountCents: number }>;
}

export interface GeneratedProjectionServerHandle {
  baseUrl: string;
  applySeed(seed: ProjectionSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedProjectionServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedProjectionServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-projection-"));

  // 1. Emit the real artifacts for the projection model.
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

  // 3. Provision the base table (snake_case, matching the EMITTED Drizzle table)
  //    AND the VIEW the generated `.existing()` binding reads through. The view's
  //    column names match the emitted view binding's physical columns, so a read
  //    through it carries every projected field.
  await executeSql(connectionUri, `
    CREATE TABLE IF NOT EXISTS "invoices" (
      "id" bigserial PRIMARY KEY,
      "reference" varchar(40) NOT NULL,
      "status" varchar(20) NOT NULL,
      "amount_cents" bigint NOT NULL
    );
    CREATE OR REPLACE VIEW "v_invoice_summary" AS
      SELECT "id", "reference", "status", "amount_cents" FROM "invoices";
  `);

  // 4. Import the EMITTED InvoiceSummary route file unmodified and mount it.
  const routes = (await import(
    pathToFileURL(join(tmp, "InvoiceSummary.routes.ts")).href
  )) as { invoiceSummaryRoutes: (f: FastifyInstance) => Promise<void> };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(routes.invoiceSummaryRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ProjectionSeed) => {
      await seedProjection(connectionUri, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Truncate + insert the projection corpus seed. Only the base table is seeded —
 *  the view derives from it on read and is never written. */
export async function seedProjection(connectionUri: string, seed: ProjectionSeed): Promise<void> {
  await executeSql(connectionUri, `TRUNCATE TABLE "invoices" RESTART IDENTITY CASCADE;`);
  for (const i of seed.invoices) {
    await executeSql(
      connectionUri,
      `INSERT INTO "invoices" ("id","reference","status","amount_cents")
       VALUES (${i.id}, ${str(i.reference)}, ${str(i.status)}, ${i.amountCents})`,
    );
  }
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
