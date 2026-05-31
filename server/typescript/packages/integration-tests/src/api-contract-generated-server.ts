// api-contract-generated-server.ts — boots the GENERATED Author routes (the
// deployed artifact) over HTTP and drives them against the api-contract corpus.
//
// Unlike the hand-rolled reference server (`api-contract-server.ts`), this lane
// does NOT re-implement the contract. It:
//
//   1. runs the real codegen (`runGen` from @metaobjectsdev/codegen-ts) against
//      the corpus `Author` metadata into a temp dir, emitting `Author.ts`
//      (Drizzle table + Zod schemas + filter/sort allowlists) and
//      `Author.routes.ts` (which calls `mountCrudRoutes` from
//      @metaobjectsdev/runtime-ts/drizzle-fastify);
//   2. dynamically imports the EMITTED `Author.routes.ts` file *unmodified* and
//      mounts `authorRoutes(fastify)` on a Fastify instance backed by a real
//      Drizzle(node-postgres) connection to the per-scenario testcontainer.
//
// This proves the generated artifact — not a stand-in — implements the
// cross-port REST contract over HTTP.
//
// dbImport resolution (the crux of "test what we generate"): runGen is
// configured with `dbImport: "./db"`, so the emitted route file contains
// `import { db } from "./db"`. We write a tiny `db.ts` alongside it in the temp
// dir that constructs a Drizzle node-postgres instance bound to this scenario's
// `connectionUri`. Bun resolves the relative `./db` (and `./Author`) specifiers
// within the temp dir, so the generated route is imported byte-for-byte as
// emitted — no monkeypatching, no re-call of mountCrudRoutes here.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import type { AuthorRow } from "./api-contract-server.ts";

// `pg` returns BIGINT (OID 20) as a string by default. The corpus uses small
// ids (1–100); parse as Number to match the cross-port wire format
// (`field.long` → JSON number). Module-global, applied once — mirrors the
// hand-rolled server.
pg.types.setTypeParser(20, (v: string) => Number(v));

/**
 * Handle for the generated-routes server under test. Mirrors the hand-rolled
 * `ServerHandle` surface the runner drives (`baseUrl`, `applySeed`, `truncate`,
 * `close`) but is backed by the emitted Drizzle artifact rather than a
 * hand-rolled ObjectManager server.
 */
export interface GeneratedServerHandle {
  fastify: FastifyInstance;
  baseUrl: string;
  truncate(): Promise<void>;
  applySeed(rows: AuthorRow[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Generate, import, and mount the Author routes against `connectionUri`.
 *
 * `metaPath` is the corpus `meta.json`; the harness loads it through the real
 * loader and drives `runGen` so the full loader → generator pipeline produces
 * the artifact under test.
 */
export async function startGeneratedServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedServerHandle> {
  // Emit INSIDE the package tree (under .gen-tmp/, gitignored) rather than the
  // OS tmpdir. The emitted route imports the bare specifier
  // `@metaobjectsdev/runtime-ts/drizzle-fastify`; Bun resolves bare imports by
  // walking up from the importing file to a node_modules chain. Only a location
  // within the workspace reaches the repo's node_modules where the workspace
  // package is linked — the OS tmpdir does not.
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-generated-"));

  // 1. Emit the real artifact. apiPrefix "/api" → routes mount under /api;
  //    dialect postgres → Postgres-flavored Drizzle table + dispatch. dbImport
  //    "./db" → the emitted route's `import { db }` resolves to our db.ts below.
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

  // 2. Write the db module the emitted route imports (`import { db } from
  //    "./db"`). Drizzle node-postgres over a pg Pool bound to this scenario's
  //    testcontainer. Bun runs the .ts directly — no build step needed.
  const dbModule = `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)} });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");

  // 3. Provision the schema to match the EMITTED Drizzle table exactly. The
  //    generated entity uses the default snake_case column-naming strategy, so
  //    `createdAt` maps to physical column `created_at` (the hand-rolled
  //    reference lane uses literal naming → `createdAt`; this lane must match
  //    what the generated artifact actually queries).
  await executeSql(
    connectionUri,
    `CREATE TABLE IF NOT EXISTS "authors" (
       "id" bigserial PRIMARY KEY,
       "name" varchar(100) NOT NULL,
       "bio" varchar(1000),
       "created_at" timestamp NOT NULL
     )`,
  );

  // 4. Import the EMITTED route file unmodified and mount it.
  const routeUrl = pathToFileURL(join(tmp, "Author.routes.ts")).href;
  const mod = (await import(routeUrl)) as { authorRoutes: (f: FastifyInstance) => Promise<void> };
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };

  const fastify = Fastify();
  await fastify.register(mod.authorRoutes);
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    fastify,
    baseUrl,
    truncate: async () => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "authors" RESTART IDENTITY');
    },
    applySeed: async (rows: AuthorRow[]) => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "authors" RESTART IDENTITY');
      for (const r of rows) {
        // Explicit-id inserts so seed ids match the corpus expectations.
        await executeSql(
          connectionUri,
          `INSERT INTO "authors" ("id", "name", "bio", "created_at") VALUES (${
            r.id ?? "DEFAULT"
          }, ${sqlStr(r.name)}, ${r.bio == null ? "NULL" : sqlStr(r.bio)}, ${sqlStr(r.createdAt)})`,
        );
      }
      // Advance the bigserial sequence past the max seeded id so the next
      // implicit-id create lands at max+1 (the create-201 contract).
      await executeSql(
        connectionUri,
        `SELECT setval(pg_get_serial_sequence('authors', 'id'), COALESCE((SELECT MAX(id) FROM authors), 1))`,
      );
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Single-quote-escape a string literal for inline SQL (seed values are
 *  fixed corpus data, not user input — this is sufficient + keeps the seed
 *  path free of a query-param plumbing layer). */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
