// bun:test entry — the report-* persistence query scenarios on Cloudflare D1's local runtime.
//
// Miniflare runs the real workerd D1 binding on a SQLite file, so this reads the report views
// `meta migrate --dialect d1` creates through D1's own API. No Docker, no cloud account. One
// fresh D1 per scenario. See docs/CONFORMANCE.md "Split coverage".

import { describe, test } from "bun:test";
import { CANONICAL_DIR, QUERIES_DIR } from "../src/paths.ts";
import { loadQueries } from "../src/scenario.ts";
import { runQueryScenarioD1, startLocalD1 } from "../src/query-scenario-d1.ts";

describe("persistence conformance — report query scenarios on Cloudflare D1 (local runtime)", () => {
  for (const scenario of loadQueries(QUERIES_DIR).filter((s) => s.name.startsWith("report-"))) {
    test(scenario.name, async () => {
      const local = await startLocalD1();
      try {
        await runQueryScenarioD1(scenario, CANONICAL_DIR, local);
      } finally {
        await local.dispose();
      }
    }, { timeout: 60_000 });
  }
});
