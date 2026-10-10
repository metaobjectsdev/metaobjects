// query-scenario-sqlite.ts — the persistence query scenarios on SQLite (libsql), and the
// shape every non-Postgres engine's runner follows:
//   1. execute the engine's committed schema artifact (TS-produced, drift-checked);
//   2. execute the scenario's seed data;
//   3. run the shared DSL through the ObjectManager and hold each result to `expect`, the
//      Postgres wire value, after mapping the engine's own spelling (engine-wire.ts).
//
// The Postgres runner is query-scenario.ts; both call runScenarioQueries, so the DSL
// translation and the comparison are one implementation.

import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely, sql } from "kysely";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CANONICAL_COLUMN_NAMING, readCanonicalSchemaSql } from "./canonical-schema.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { runScenarioQueries } from "./query-scenario.ts";
import { splitStatements } from "./sql-script.ts";
import type { QueryScenario } from "./scenario.ts";

/** libsql executes one statement per call. */
export async function applySqlScript(db: Kysely<never>, script: string): Promise<void> {
  for (const stmt of splitStatements(script)) {
    await sql.raw(stmt).execute(db);
  }
}

export async function runQueryScenarioSqlite(
  scenario: QueryScenario,
  canonicalDir: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "query-scenario-sqlite-"));
  const kysely = new Kysely<never>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "test.db")}` }) });
  try {
    await applySqlScript(kysely, readCanonicalSchemaSql("sqlite"));
    const seed = scenario.seedDataEngine?.sqlite ?? scenario.seedData;
    if (seed && seed.trim().length > 0) await applySqlScript(kysely, seed);

    const root = await loadMetadataDir(canonicalDir);
    const driver = kyselyDriver({ db: kysely as never, dialect: "sqlite" });
    const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: CANONICAL_COLUMN_NAMING });
    await runScenarioQueries(scenario, om, root, "sqlite");
  } finally {
    await kysely.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}
