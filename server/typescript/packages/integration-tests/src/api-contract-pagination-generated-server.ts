// api-contract-pagination-generated-server.ts — boots the GENERATED Item routes (the deployed
// artifact) over HTTP and drives them against the pagination corpus. The page size is not passed
// here: it reaches the emitted routes from the corpus's own `.metaobjects/config.json`, read by
// the metadata load, which is the path an adopter's `api.pagination` takes.
//
// Same shape as api-contract-secret-fields-generated-server.ts: runGen over the corpus meta into
// a temp dir, provision the table the emitted Drizzle binding reads, mount the EMITTED routes.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import type pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface PaginationSeed {
  rows: Array<{ id: number; title: string }>;
}

export interface GeneratedPaginationServerHandle {
  baseUrl: string;
  applySeed(seed: PaginationSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedPaginationServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedPaginationServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-pagination-"));

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
    `CREATE TABLE IF NOT EXISTS "items" (
       "id" bigserial PRIMARY KEY,
       "title" varchar(100) NOT NULL
     );`,
  );

  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  const mod = (await import(pathToFileURL(join(tmp, "Item.routes.ts")).href)) as Record<
    string,
    (f: FastifyInstance) => Promise<void>
  >;
  await fastify.register(mod["itemRoutes"]!);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: PaginationSeed) => {
      await executeSql(connectionUri, `TRUNCATE TABLE "items" RESTART IDENTITY;`);
      for (const r of seed.rows)
        await executeSql(connectionUri, `INSERT INTO "items" ("id","title") VALUES (${r.id}, ${str(r.title)})`);
      await executeSql(connectionUri, `SELECT setval(pg_get_serial_sequence('items','id'), (SELECT MAX("id") FROM "items"));`);
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
