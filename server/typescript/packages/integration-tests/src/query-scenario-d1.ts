// query-scenario-d1.ts — the persistence query scenarios on Cloudflare D1's LOCAL runtime
// (Miniflare, which runs the real workerd D1 binding on a SQLite file). No cloud account.
//
// The schema is not a committed artifact: it is what `meta migrate --dialect d1` produces for
// the canonical model (the same diff + emit, D1's own spelling and safety pass), generated on
// each run and executed through the D1 binding's `exec`. D1 is SQLite at the SQL level, so the
// SQLite seed and the SQLite wire spelling apply.

import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Miniflare } from "miniflare";
import { Kysely } from "kysely";

import { CANONICAL_COLUMN_NAMING, generateCanonicalSchemaSql } from "./canonical-schema.ts";
import { d1Dialect, type D1Like } from "./d1-kysely.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { runScenarioQueries } from "./query-scenario.ts";
import { stripSqlComments } from "./query-scenario-sqlite.ts";
import type { QueryScenario } from "./scenario.ts";

interface D1Database extends D1Like {
  exec(sql: string): Promise<unknown>;
}

const D1_BINDING = "DB";

/** One local D1 database: a Miniflare instance and its D1 binding. */
export interface LocalD1 {
  d1: D1Database;
  dispose(): Promise<void>;
}

export async function startLocalD1(): Promise<LocalD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { [D1_BINDING]: "report-dialects-local-d1" },
    d1Persist: false,
  });
  const d1 = (await mf.getD1Database(D1_BINDING)) as unknown as D1Database;
  return { d1, dispose: () => mf.dispose() };
}

/** D1's `exec` runs one statement per line; fold each statement onto one line first. */
export async function execScript(d1: D1Database, script: string): Promise<void> {
  for (const stmt of stripSqlComments(script).split(";").map((s) => s.trim()).filter(Boolean)) {
    await d1.exec(stmt.replace(/\s*\n\s*/g, " "));
  }
}

export async function runQueryScenarioD1(
  scenario: QueryScenario,
  canonicalDir: string,
  local: LocalD1,
): Promise<void> {
  const root = await loadMetadataDir(canonicalDir);
  await execScript(local.d1, await generateCanonicalSchemaSql(root, { dialect: "d1" }));
  const seed = scenario.seedDataEngine?.sqlite ?? scenario.seedData;
  if (seed && seed.trim().length > 0) await execScript(local.d1, seed);

  const kysely = new Kysely<never>({ dialect: d1Dialect(local.d1) });
  const driver = kyselyDriver({ db: kysely as never, dialect: "sqlite" });
  const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: CANONICAL_COLUMN_NAMING });
  await runScenarioQueries(scenario, om, root, "sqlite");
}
