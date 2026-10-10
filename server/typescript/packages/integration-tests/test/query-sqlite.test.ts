// bun:test entry — the report-* persistence query scenarios on SQLite.
//
// Only the report scenarios: the rest of the corpus gates the entity runtime on Postgres, and
// SQLite's gate there is its own (migrate-ts, the codegen lanes). A report is the part whose SQL
// is dialect-specific — conditional aggregates, grains, relative dates, the ratio's division —
// and that SQL is what an engine's lane has to run. See docs/CONFORMANCE.md "Split coverage".

import { describe, test } from "bun:test";
import { CANONICAL_DIR, QUERIES_DIR } from "../src/paths.ts";
import { loadQueries } from "../src/scenario.ts";
import { runQueryScenarioSqlite } from "../src/query-scenario-sqlite.ts";

describe("persistence conformance — report query scenarios on SQLite", () => {
  for (const scenario of loadQueries(QUERIES_DIR).filter((s) => s.name.startsWith("report-"))) {
    test(scenario.name, async () => {
      await runQueryScenarioSqlite(scenario, CANONICAL_DIR);
    }, { timeout: 60_000 });
  }
});
