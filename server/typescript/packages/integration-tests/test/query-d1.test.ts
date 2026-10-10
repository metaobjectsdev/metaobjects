// bun:test entry — the report-* persistence query scenarios on Cloudflare D1's local runtime.
//
// Miniflare runs the real workerd D1 binding on a SQLite file, so this reads the report views
// `meta migrate --dialect d1` creates through D1's own API. No Docker, no cloud account. One
// fresh D1 per scenario. See docs/CONFORMANCE.md "Split coverage".

import { beforeAll, describe, test } from "bun:test";
import { CANONICAL_DIR, QUERIES_DIR } from "../src/paths.ts";
import { generateCanonicalSchemaSql } from "../src/canonical-schema.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { loadReportQueries } from "../src/scenario.ts";
import { runQueryScenarioD1, startLocalD1 } from "../src/query-scenario-d1.ts";

// The D1 schema has no committed artifact (see query-scenario-d1.ts), but it depends only on the
// metadata — the whole migrate pipeline runs once for the suite instead of once per scenario.
let schemaSql: string;
beforeAll(async () => {
  schemaSql = await generateCanonicalSchemaSql(await loadMetadataDir(CANONICAL_DIR), { dialect: "d1" });
}, 120_000);

describe("persistence conformance — report query scenarios on Cloudflare D1 (local runtime)", () => {
  for (const scenario of loadReportQueries(QUERIES_DIR)) {
    test(scenario.name, async () => {
      const local = await startLocalD1();
      try {
        await runQueryScenarioD1(scenario, CANONICAL_DIR, local, schemaSql);
      } finally {
        await local.dispose();
      }
    }, { timeout: 60_000 });
  }
});
