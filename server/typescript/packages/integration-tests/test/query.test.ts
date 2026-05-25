// bun:test entry — one test per scenario in fixtures/persistence-conformance/queries/.

import { describe, test } from "bun:test";
import { CANONICAL_DIR, QUERIES_DIR } from "../src/paths.ts";
import { loadQueries } from "../src/scenario.ts";
import { runQueryScenario } from "../src/query-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";

describe("persistence conformance — query scenarios", () => {
  for (const scenario of loadQueries(QUERIES_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      try {
        await runQueryScenario(scenario, pg.connectionUri, CANONICAL_DIR);
      } finally {
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});
