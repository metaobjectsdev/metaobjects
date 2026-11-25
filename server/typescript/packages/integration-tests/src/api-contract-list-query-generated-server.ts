// api-contract-list-query-generated-server.ts — boots the GENERATED Part routes (the deployed
// artifact) over HTTP for the list-query sub-corpus: search, or/and, the nesting cap, bare
// fields, leading wildcards, value formats and the body/id/constraint refusals.
//
// Same shape as api-contract-api-settings-generated-server.ts: runGen over the corpus meta into
// a temp dir, provision the table the emitted Drizzle binding reads, mount the EMITTED routes.

import type { FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import type pg from "pg";
import { apiGenerators, serveApi, type ApiLane } from "./api-lane.ts";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface ListQuerySeed {
  rows: Array<{ id: number; name: string; sku: string; category: string; stock: number; notes: string }>;
}

export interface GeneratedListQueryServerHandle {
  baseUrl: string;
  applySeed(seed: ListQuerySeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedListQueryServer(
  connectionUri: string,
  metaPath: string,
  lane: ApiLane = "routes",
): Promise<GeneratedListQueryServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-list-query-"));

  try {
    const root = await loadMetadataFile(metaPath);
    const lr = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "./db",
        dialect: "postgres",
        apiPrefix: "/api",
        generators: apiGenerators(lane, [entityFile()], () => [routesFile()]),
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
      `CREATE TABLE IF NOT EXISTS "parts" (
         "id" bigserial PRIMARY KEY,
         "name" varchar(100) NOT NULL,
         "sku" varchar(20) NOT NULL UNIQUE,
         "category" varchar(4) NOT NULL CHECK ("category" IN ('tool', 'part', 'kit')),
         "stock" integer NOT NULL,
         "notes" varchar(200)
       );`,
    );

    const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool; db: unknown };

    const served = await serveApi(lane, tmp, dbMod.db, async (fastify) => {
      const mod = (await import(pathToFileURL(join(tmp, "Part.routes.ts")).href)) as Record<
        string,
        (f: FastifyInstance) => Promise<void>
      >;
      await fastify.register(mod["partRoutes"]!);
    });
    const baseUrl = served.baseUrl;

    return {
      baseUrl,
      applySeed: async (seed: ListQuerySeed) => {
        const values = seed.rows
          .map((r) => `(${r.id}, ${str(r.name)}, ${str(r.sku)}, ${str(r.category)}, ${r.stock}, ${str(r.notes)})`)
          .join(",\n");
        await executeSql(
          connectionUri,
          `TRUNCATE TABLE "parts" RESTART IDENTITY;
           INSERT INTO "parts" ("id","name","sku","category","stock","notes") VALUES ${values};
           SELECT setval(pg_get_serial_sequence('parts','id'), (SELECT MAX("id") FROM "parts"));`,
        );
      },
      close: async () => {
        await served.close();
        await dbMod.pool.end();
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
