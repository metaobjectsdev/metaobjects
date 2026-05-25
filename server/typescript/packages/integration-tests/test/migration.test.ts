// bun:test entry — one test per scenario in fixtures/persistence-conformance/migrations/.

import { describe, test } from "bun:test";
import { MIGRATIONS_DIR } from "../src/paths.ts";
import { loadMigrations } from "../src/scenario.ts";
import { runMigrationScenario } from "../src/migration-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";

describe("persistence conformance — migration scenarios", () => {
  for (const scenario of loadMigrations(MIGRATIONS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      try {
        await runMigrationScenario(scenario, pg.connectionUri);
      } finally {
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});
