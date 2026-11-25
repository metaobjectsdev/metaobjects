// api-contract-enum-default-generated-server.ts — boots the GENERATED Ticket routes (the
// deployed artifact) over HTTP and drives them against the enum-default corpus.
//
// Same shape as api-contract-secret-fields-generated-server.ts: runGen over the corpus meta into
// a temp dir, provision the table the emitted Drizzle binding reads, mount the EMITTED routes.

import type { FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { indexEmitted, type OutputLayout } from "./output-layout.ts";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import { apiGenerators, serveApi, type ApiLane } from "./api-lane.ts";
import type pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { DEFAULT_PHYSICAL_NAMING } from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "./load-metadata.ts";

export interface EnumDefaultSeed {
  rows: Array<{ id: number; title: string; priority: string }>;
}

export interface GeneratedEnumDefaultServerHandle {
  baseUrl: string;
  applySeed(seed: EnumDefaultSeed): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedEnumDefaultServer(
  connectionUri: string,
  metaPath: string,
  outputLayout: OutputLayout = "flat",
  lane: ApiLane = "routes",
): Promise<GeneratedEnumDefaultServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-enum-default-"));

  const root = await loadMetadataFile(metaPath);
  root.physicalNaming = DEFAULT_PHYSICAL_NAMING;
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      outputLayout,
      dbImport: "./db",
      dialect: "postgres",
      apiPrefix: "/api",
      generators: apiGenerators(lane, [entityFile()], () => [routesFile()]),
    }),
    metadata: root,
  });
  const emitted = indexEmitted(tmp, lr.files, outputLayout);
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

  // TypeScript applies `@default` as the column DEFAULT that `meta migrate` emits (the generated
  // insert omits the column), so the table is provisioned with it, as the migration would.
  await executeSql(
    connectionUri,
    `CREATE TABLE IF NOT EXISTS "tickets" (
       "id" bigserial PRIMARY KEY,
       "title" varchar(100) NOT NULL,
       "priority" varchar(255) DEFAULT 'NORMAL'
     );`,
  );

  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool; db: unknown };

  const served = await serveApi(lane, tmp, dbMod.db, async (fastify) => {
    const mod = (await import(pathToFileURL(emitted.locate("Ticket.routes.ts")).href)) as Record<
      string,
      (f: FastifyInstance) => Promise<void>
    >;
    await fastify.register(mod["ticketRoutes"]!);
  });
  const baseUrl = served.baseUrl;

  return {
    baseUrl,
    applySeed: async (seed: EnumDefaultSeed) => {
      await executeSql(connectionUri, `TRUNCATE TABLE "tickets" RESTART IDENTITY;`);
      for (const r of seed.rows)
        await executeSql(
          connectionUri,
          `INSERT INTO "tickets" ("id","title","priority") VALUES (${r.id}, ${str(r.title)}, ${str(r.priority)})`,
        );
      await executeSql(connectionUri, `SELECT setval(pg_get_serial_sequence('tickets','id'), (SELECT MAX("id") FROM "tickets"));`);
    },
    close: async () => {
      await served.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function str(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
