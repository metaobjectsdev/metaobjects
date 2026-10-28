// api-contract-secret-fields-generated-server.ts — boots the GENERATED Account routes
// (the deployed artifact) over HTTP and drives them against the #484 secret-fields corpus.
//
// Mirrors api-contract-write-through-generated-server.ts: runGen over the corpus meta into a
// temp dir, provision the table the emitted Drizzle binding reads, import the EMITTED
// Account.routes.ts unmodified and mount it. What is under test is whether the generated
// route strips `@formExclude` / credential keys from a write body and omits a credential
// from every row it sends.

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

  const root = await loadMetadataFile(metaPath);
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
     );`,
  );

  const routesPath = join(tmp, "Account.routes.ts");
  const accountRoutes = (await import(pathToFileURL(routesPath).href)) as {
    accountRoutes: (f: FastifyInstance) => Promise<void>;
  };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(accountRoutes.accountRoutes);
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
