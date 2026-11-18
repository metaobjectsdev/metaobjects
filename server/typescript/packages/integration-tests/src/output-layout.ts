// output-layout.ts — shared support for running the generated-server lanes in both
// codegen output layouts.
//
// `flat` puts every emitted file directly under outDir; `package` folds them into one
// directory per metadata package (`acme::blog` -> `acme/blog/Author.ts`). A harness
// therefore cannot hard-code `join(outDir, "Author.routes.ts")`: it asks the run's
// emitted file list where the file went.
//
// The database module (`db.ts`) is written by the harness at outDir root in both
// layouts. Codegen re-relativises a relative `dbImport` per emitted file (one `../` per
// package segment), so a route two directories down still imports `../../db`.

import { beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Client } from "pg";
import { startPostgres, type RunningPg } from "./postgres-container.ts";

export type OutputLayout = "flat" | "package";

export const OUTPUT_LAYOUTS: readonly OutputLayout[] = ["flat", "package"];

/** Resolves an emitted file, by base name, to its absolute path in the run's output tree. */
export interface EmittedFiles {
  /** Every emitted path, relative to outDir, POSIX separators. */
  readonly relative: readonly string[];
  /** Absolute path of the one emitted file whose base name is `name`; throws if none or several. */
  locate(name: string): string;
  /** Whether some emitted file has base name `name`. */
  has(name: string): boolean;
}

/**
 * Index a `runGen` result. Under the package layout, throws unless at least one emitted
 * path sits in a subdirectory, so a lane that claims to cover the folded layout cannot
 * silently run flat.
 */
export function indexEmitted(outDir: string, files: ReadonlyArray<{ path: string }>, layout: OutputLayout): EmittedFiles {
  const relative = files.map((f) => {
    if (!isAbsolute(f.path)) return f.path;
    return f.path.startsWith(`${outDir}/`) ? f.path.slice(outDir.length + 1) : f.path;
  });
  if (layout === "package" && !relative.some((p) => p.includes("/"))) {
    throw new Error(`outputLayout "package" emitted no file in a subdirectory: ${relative.join(", ")}`);
  }
  const matches = (name: string): string[] => relative.filter((p) => p === name || p.endsWith(`/${name}`));
  return {
    relative,
    has: (name) => matches(name).length > 0,
    locate: (name) => {
      const hits = matches(name);
      if (hits.length !== 1) {
        throw new Error(`expected exactly one emitted ${name}, found ${hits.length}: [${hits.join(", ")}] of [${relative.join(", ")}]`);
      }
      return join(outDir, hits[0]!);
    },
  };
}

/**
 * Database source for one describe block. `flat` keeps today's behaviour: a fresh
 * Postgres per call. `package` boots ONE Postgres for the whole block and hands out a
 * fresh database inside it per call, so the added lane costs no container per scenario.
 * Call it inside the `describe` callback (it registers the block's hooks).
 */
export function postgresFor(layout: OutputLayout): () => Promise<RunningPg> {
  if (layout === "flat") return () => startPostgres();

  let shared: RunningPg | undefined;
  beforeAll(async () => { shared = await startPostgres(); }, 240_000);
  afterAll(async () => { await shared?.stop(); }, 60_000);

  return async () => {
    if (shared === undefined) throw new Error("shared Postgres is not running");
    const adminUri = shared.connectionUri;
    const name = `mo_layout_${randomUUID().replace(/-/g, "")}`;
    await withAdmin(adminUri, (c) => c.query(`CREATE DATABASE "${name}"`));
    const u = new URL(adminUri);
    u.pathname = `/${name}`;
    return {
      connectionUri: u.toString(),
      stop: async () => { await withAdmin(adminUri, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)); },
    };
  };
}

async function withAdmin(adminUri: string, run: (c: Client) => Promise<unknown>): Promise<void> {
  const c = new Client({ connectionString: adminUri, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try { await run(c); } finally { await c.end(); }
}
