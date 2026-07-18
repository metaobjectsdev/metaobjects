// api-contract-write-through-generated-server.ts — boots the GENERATED Order
// routes (the deployed artifact) over HTTP and drives them against the #214
// write-through corpus.
//
// Mirrors api-contract-m2m-generated-server.ts, but the model is a WRITE-THROUGH
// entity: Order has a writable `orders` table AND a read-only replica view
// `v_order_with_customer` carrying the derived `customerName` (origin.passthrough
// from Customer.name). It:
//   1. runs the real codegen (runGen) over the write-through meta into a temp dir,
//      emitting Order's Drizzle table + the `.existing()` replica VIEW binding +
//      Order.routes.ts — which (post-fix) mounts mountCrudRoutes with `readView`;
//   2. provisions the `customers` + `orders` tables AND the `v_order_with_customer`
//      SQL view the generated `.existing()` binding reads through;
//   3. imports the EMITTED Order.routes.ts unmodified and mounts it.
//
// This proves the GENERATED write-through routes — the deployed artifact, not a
// re-implementation — return the derived field on read-your-writes over HTTP.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface WriteThroughSeed {
  customers: Array<{ id: number; name: string }>;
  orders: Array<{ id: number; customerId: number }>;
}

export interface GeneratedWriteThroughServerHandle {
  baseUrl: string;
  applySeed(seed: WriteThroughSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedWriteThroughServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedWriteThroughServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-write-through-"));

  // 1. Emit the real artifacts for the write-through model.
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

  // 3. Provision the base tables (snake_case, matching the EMITTED Drizzle table)
  //    AND the replica VIEW the generated `.existing()` binding reads through. The
  //    view columns (id / customer_id / customer_name) match orderView's physical
  //    column names, so a read routed through it carries the derived customerName.
  await executeSql(connectionUri, `
    CREATE TABLE IF NOT EXISTS "customers" ("id" bigserial PRIMARY KEY, "name" varchar(80) NOT NULL);
    CREATE TABLE IF NOT EXISTS "orders" ("id" bigserial PRIMARY KEY, "customer_id" bigint NOT NULL);
    CREATE OR REPLACE VIEW "v_order_with_customer" AS
      SELECT o."id" AS "id", o."customer_id" AS "customer_id", c."name" AS "customer_name"
      FROM "orders" o JOIN "customers" c ON o."customer_id" = c."id";
  `);

  // 4. Import the EMITTED Order route file unmodified and mount it.
  const orderRoutes = (await import(pathToFileURL(join(tmp, "Order.routes.ts")).href)) as {
    orderRoutes: (f: FastifyInstance) => Promise<void>;
  };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(orderRoutes.orderRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: WriteThroughSeed) => {
      await seedWriteThrough(connectionUri, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Truncate + insert the write-through corpus seed (base tables only — the
 *  derived customerName is produced by the view join on read). */
export async function seedWriteThrough(connectionUri: string, seed: WriteThroughSeed): Promise<void> {
  await executeSql(connectionUri, `TRUNCATE TABLE "customers","orders" RESTART IDENTITY CASCADE;`);
  for (const c of seed.customers)
    await executeSql(connectionUri, `INSERT INTO "customers" ("id","name") VALUES (${c.id}, ${str(c.name)})`);
  for (const o of seed.orders)
    await executeSql(connectionUri, `INSERT INTO "orders" ("id","customer_id") VALUES (${o.id}, ${o.customerId})`);
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
