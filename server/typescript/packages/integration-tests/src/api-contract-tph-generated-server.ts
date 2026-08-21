// api-contract-tph-generated-server.ts — boots the GENERATED TPH routes (the
// deployed artifact) over HTTP and drives them against the FR-017 TPH corpus.
//
// Mirrors api-contract-m2m-generated-server.ts but for the single-table
// table-per-hierarchy model (Auth + BridgeAuth / CopayAuth / PriorAuthAuth). It:
//   1. runs the real codegen (runGen from @metaobjectsdev/codegen-ts) over the
//      TPH meta into a temp dir, emitting the single Drizzle `auths` table +
//      per-subtype Zod/allowlists AND Auth.routes.ts — which mounts the
//      polymorphic list/get at the base path plus a full per-subtype CRUD set
//      at /auths/<discriminatorValue lowercased>;
//   2. provisions the ONE physical `auths` table (subtype-only columns nullable);
//   3. imports the EMITTED Auth.routes.ts unmodified and mounts it on a Fastify
//      instance backed by a real Drizzle(node-postgres) connection.
//
// This proves the GENERATED TPH routes — not a stand-in — implement the
// cross-port contract over HTTP.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface TphSeed {
  auths: Array<{
    id: number;
    type: string;
    reference: string;
    quantity: number | null;
    copayAmount: string | null;
    approver: string | null;
    // FR-037 R1 — the @mutability "writeOnce" column, declared on the TPH BASE so
    // every subtype inherits it (which also exercises the resolving-accessor rule:
    // an own-only read would see readWrite on each subtype).
    issuedCurrency?: string | null;
    // #203 / ADR-0045 — @autoSet timestamp columns (TPH leg). Present verbatim
    // in the seed (an OLD sentinel) so a PATCH can prove it bumps
    // autoUpdatedAt (onUpdate) while leaving autoCreatedAt (onCreate) untouched.
    autoCreatedAt?: string;
    autoUpdatedAt?: string;
  }>;
}

export interface GeneratedTphServerHandle {
  baseUrl: string;
  applySeed(seed: TphSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedTphServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedTphServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-tph-"));

  // 1. Emit the real artifacts for the TPH hierarchy.
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

  // 3. Provision the SINGLE TPH table to match the EMITTED Drizzle table.
  //    Subtype-only columns (quantity / copay_amount / approver) are nullable.
  //    #203 / ADR-0045 — auto_created_at/auto_updated_at mirror the emitted
  //    Auth.ts columns (physical snake_case naming). Plain `timestamp` here
  //    (not `timestamptz`) matches the precedent in api-contract-generated-server.ts
  //    — the physical DDL type doesn't need to match the Drizzle column's
  //    `withTimezone` config bit-for-bit for the write/read path to function.
  await executeSql(connectionUri, `
    CREATE TABLE IF NOT EXISTS "auths" (
      "id"              bigserial PRIMARY KEY,
      "type"            text,
      "reference"       varchar(80) NOT NULL,
      "quantity"        integer,
      "copay_amount"    numeric(10,2),
      "approver"        varchar(80),
      "issued_currency" varchar(3),
      "auto_created_at" timestamp,
      "auto_updated_at" timestamp
    );
  `);

  // 4. Import the EMITTED Auth.routes.ts unmodified and mount it.
  const authRoutesMod = (await import(pathToFileURL(join(tmp, "Auth.routes.ts")).href)) as {
    authRoutes: (f: FastifyInstance) => Promise<void>;
  };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(authRoutesMod.authRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: TphSeed) => {
      await seedTph(connectionUri, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Truncate + insert the TPH corpus seed into the single `auths` table. */
export async function seedTph(connectionUri: string, seed: TphSeed): Promise<void> {
  await executeSql(connectionUri, `TRUNCATE TABLE "auths" RESTART IDENTITY;`);
  for (const a of seed.auths) {
    // #203 / ADR-0045 — auto_created_at/auto_updated_at are seeded VERBATIM via
    // direct SQL (the OLD sentinel), bypassing BOTH lanes' stamping paths (the
    // generated Zod InsertSchema's @autoSet transform, and the reference
    // server's equivalent hand-written transform) — this seedTph function is
    // shared by both lanes' applySeed. A subsequent PATCH flows through the
    // real UpdateSchema/handler, which bumps autoUpdatedAt and leaves
    // autoCreatedAt untouched — so the two diverge, which is what the
    // tph-autoset-patch scenario asserts.
    await executeSql(
      connectionUri,
      `INSERT INTO "auths" ("id","type","reference","quantity","copay_amount","approver","issued_currency","auto_created_at","auto_updated_at")
       VALUES (${a.id}, ${str(a.type)}, ${str(a.reference)}, ${num(a.quantity)}, ${num(a.copayAmount)}, ${str(a.approver)}, ${str(a.issuedCurrency ?? null)}, ${str(a.autoCreatedAt ?? null)}, ${str(a.autoUpdatedAt ?? null)})`,
    );
  }
  // Seeding explicit ids into the bigserial PK does NOT advance its sequence, so
  // a subsequent create (POST /auths/<sub>, id=DEFAULT) would collide on id=1.
  // Bump the sequence past the seeded max so generated inserts get fresh ids.
  await executeSql(
    connectionUri,
    `SELECT setval(pg_get_serial_sequence('auths','id'), (SELECT COALESCE(MAX(id), 1) FROM auths));`,
  );
}

function str(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function num(v: number | string | null): string {
  if (v === null) return "NULL";
  return String(v);
}
