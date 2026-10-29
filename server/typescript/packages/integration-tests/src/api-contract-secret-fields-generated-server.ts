// api-contract-secret-fields-generated-server.ts — boots the GENERATED Account routes
// (the deployed artifact) over HTTP and drives them against the #484 secret-fields corpus.
//
// Mirrors api-contract-write-through-generated-server.ts: runGen over the corpus meta into a
// temp dir, provision the table the emitted Drizzle binding reads, import the EMITTED
// Account.routes.ts unmodified and mount it. What is under test is whether the generated
// route strips `@formExclude` / credential keys from a write body and omits a credential
// from every row it sends.
//
// Beside the corpus model it loads READ_PATHS: a view projection whose `pinHash` extends
// `Account.pinHash`, and an M:N from Payer onto the TPH base Auth whose subtype BridgeAuth
// declares a credential. Their emitted routes are mounted too, so the credential redaction of
// the projection and the M:N traversal is driven over HTTP as well.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { DEFAULT_PHYSICAL_NAMING } from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "./load-metadata.ts";

const READ_PATHS = {
  "metadata.root": {
    package: "acme::secrets",
    children: [
      { "object.projection": { name: "AccountView", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_account" } },
        { "field.long": { name: "id", extends: "Account.id" } },
        { "field.string": { name: "name", extends: "Account.name" } },
        { "field.string": { name: "pinHash", extends: "Account.pinHash" } },
        { "identity.primary": { name: "id", extends: "Account.id" } },
      ] } },
      { "object.entity": { name: "Payer", children: [
        { "source.rdb": { "@table": "payers" } },
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "auths", "@cardinality": "many", "@objectRef": "Auth", "@through": "PayerAuth" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge", children: [
        { "field.string": { name: "pinHash", "@maxLength": 100, children: [{ "view.password": {} }] } },
      ] } },
      { "object.entity": { name: "CopayAuth", extends: "Auth", "@discriminatorValue": "Copay", children: [
        { "field.int": { name: "copayCents" } },
      ] } },
      { "object.entity": { name: "PayerAuth", children: [
        { "source.rdb": { "@table": "payer_auths" } },
        { "field.long": { name: "payerId", "@required": true } },
        { "field.long": { name: "authId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["payerId", "authId"] } },
        { "identity.reference": { name: "fkPayer", "@fields": "payerId", "@references": "Payer" } },
        { "identity.reference": { name: "fkAuth", "@fields": "authId", "@references": "Auth" } },
      ] } },
    ],
  },
};

export interface SecretFieldsSeed {
  rows: Array<{ id: number; name: string; tokenHash: string; pinHash: string }>;
}

export interface GeneratedSecretFieldsServerHandle {
  baseUrl: string;
  applySeed(seed: SecretFieldsSeed): Promise<void>;
  /** The stored accounts, read straight from the table (the HTTP API never returns a credential). */
  storedRows(): Promise<Array<{ id: number; tokenHash: string | null; pinHash: string | null }>>;
  close(): Promise<void>;
}

export async function startGeneratedSecretFieldsServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedSecretFieldsServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-secret-fields-"));

  const readPaths = join(tmp, "read-paths.meta.json");
  writeFileSync(readPaths, JSON.stringify(READ_PATHS), "utf8");
  const root = await loadMetadataFile(metaPath, readPaths);
  // The lane provisions its table below in the generated Drizzle table's default spelling.
  root.physicalNaming = DEFAULT_PHYSICAL_NAMING;
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

  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  writeFileSync(
    join(tmp, "db.ts"),
    `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`,
    "utf8",
  );

  await executeSql(
    connectionUri,
    `CREATE TABLE IF NOT EXISTS "accounts" (
       "id" bigserial PRIMARY KEY,
       "name" varchar(100) NOT NULL,
       "token_hash" varchar(100),
       "pin_hash" varchar(100)
     );
     CREATE OR REPLACE VIEW "v_account" AS SELECT "id", "name", "pin_hash" FROM "accounts";
     CREATE TABLE IF NOT EXISTS "payers" ("id" bigserial PRIMARY KEY);
     CREATE TABLE IF NOT EXISTS "auths" (
       "id" bigserial PRIMARY KEY,
       "type" varchar(16) NOT NULL,
       "pin_hash" varchar(100),
       "copay_cents" integer
     );
     CREATE TABLE IF NOT EXISTS "payer_auths" (
       "payer_id" bigint NOT NULL,
       "auth_id" bigint NOT NULL,
       PRIMARY KEY ("payer_id", "auth_id")
     );
     INSERT INTO "payers" ("id") VALUES (1);
     INSERT INTO "auths" ("id", "type", "pin_hash", "copay_cents") VALUES (1, 'Bridge', 'auth-pin-1', NULL), (2, 'Copay', NULL, 500);
     INSERT INTO "payer_auths" ("payer_id", "auth_id") VALUES (1, 1), (1, 2);`,
  );

  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  for (const [file, plugin] of [
    ["Account.routes.ts", "accountRoutes"],
    ["AccountView.routes.ts", "accountViewRoutes"],
    ["Payer.routes.ts", "payerRoutes"],
  ] as const) {
    const mod = (await import(pathToFileURL(join(tmp, file)).href)) as Record<string, (f: FastifyInstance) => Promise<void>>;
    await fastify.register(mod[plugin]!);
  }
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: SecretFieldsSeed) => {
      await executeSql(connectionUri, `TRUNCATE TABLE "accounts" RESTART IDENTITY;`);
      for (const r of seed.rows)
        await executeSql(
          connectionUri,
          `INSERT INTO "accounts" ("id","name","token_hash","pin_hash") VALUES (${r.id}, ${str(r.name)}, ${str(r.tokenHash)}, ${str(r.pinHash)})`,
        );
      // The seed names ids explicitly; keep the sequence ahead of them for the POST scenarios.
      await executeSql(connectionUri, `SELECT setval(pg_get_serial_sequence('accounts','id'), (SELECT MAX("id") FROM "accounts"));`);
    },
    storedRows: async () => {
      const res = await dbMod.pool.query<{ id: number; token_hash: string | null; pin_hash: string | null }>(
        `SELECT "id", "token_hash", "pin_hash" FROM "accounts" ORDER BY "id"`,
      );
      return res.rows.map((r) => ({ id: Number(r.id), tokenHash: r.token_hash, pinHash: r.pin_hash }));
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
