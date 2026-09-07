// api-contract-jsonb-generated-server.ts — boots the GENERATED Document routes
// (the deployed artifact) over HTTP and drives them against the
// api-contract-conformance/jsonb/ corpus.
//
// This is the lane that actually pins the contract: it runs the real codegen
// (entityFile → Drizzle `jsonb()` column + Zod `unknown` schema; routesFile →
// drizzle-fastify mountCrudRoutes) for the corpus `Document` entity, imports
// the EMITTED `Document.routes.ts` unmodified, and mounts it on Fastify backed
// by a real Postgres testcontainer. If the generated artifact returned the
// jsonb open bag as a stringified value instead of a parsed object, the
// scenario's deep-equal would fail here.
//
// Mirrors api-contract-generated-server.ts (the Author generated lane).

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import type { DocumentRow } from "./api-contract-jsonb-server.ts";

export interface GeneratedJsonbServerHandle {
  fastify: FastifyInstance;
  baseUrl: string;
  truncate(): Promise<void>;
  applySeed(rows: DocumentRow[]): Promise<void>;
  close(): Promise<void>;
}

export async function startGeneratedJsonbServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedJsonbServerHandle> {
  // Emit INSIDE the package tree (under .gen-tmp/, gitignored) so the emitted
  // route's bare `@metaobjectsdev/runtime-ts/drizzle-fastify` import resolves
  // through the workspace node_modules. Mirrors the Author generated lane.
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-jsonb-generated-"));

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
  const dbModule = `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");

  // Provision the schema to match the EMITTED Drizzle table. Default
  // snake_case naming keeps the single-word fields (`title`, `payload`) as-is
  // and lowers the Marker VO columns to `primary_marker` / `optional_marker` /
  // `markers`. `payload` is the open bag; the three VO columns are jsonb too
  // (`primary_marker` is @required → NOT NULL). Program D.
  await executeSql(
    connectionUri,
    `CREATE TABLE IF NOT EXISTS "documents" (
       "id" bigserial PRIMARY KEY,
       "title" varchar(200) NOT NULL,
       "payload" jsonb,
       "primary_marker" jsonb NOT NULL,
       "optional_marker" jsonb,
       "markers" jsonb
     )`,
  );

  const routeUrl = pathToFileURL(join(tmp, "Document.routes.ts")).href;
  const mod = (await import(routeUrl)) as { documentRoutes: (f: FastifyInstance) => Promise<void> };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(mod.documentRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    fastify,
    baseUrl,
    truncate: async () => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "documents" RESTART IDENTITY');
    },
    applySeed: async (rows: DocumentRow[]) => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "documents" RESTART IDENTITY');
      for (const r of rows) {
        const jsonbSql = (v: unknown) =>
          v === undefined || v === null ? "NULL" : `${sqlStr(JSON.stringify(v))}::jsonb`;
        await executeSql(
          connectionUri,
          `INSERT INTO "documents" ("id", "title", "payload", "primary_marker", "optional_marker", "markers") VALUES (${
            r.id ?? "DEFAULT"
          }, ${sqlStr(r.title)}, ${jsonbSql(r.payload)}, ${jsonbSql(r.primaryMarker)}, ${jsonbSql(
            r.optionalMarker,
          )}, ${jsonbSql(r.markers)})`,
        );
      }
      await executeSql(
        connectionUri,
        `SELECT setval(pg_get_serial_sequence('documents', 'id'), COALESCE((SELECT MAX(id) FROM documents), 1))`,
      );
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Single-quote-escape a string literal for inline SQL (seed values are fixed
 *  corpus data, not user input). */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
