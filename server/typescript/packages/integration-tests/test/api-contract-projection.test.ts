// F22 view-only-projection api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/projection/ over HTTP against the
// GENERATED InvoiceSummary routes — the emitted InvoiceSummary.routes.ts booted
// unmodified against a real Postgres testcontainer with v_invoice_summary
// present. This is the gate for "all five ports serve projections": before it,
// TS and C# mounted read-only routes for an object.projection and Java, Kotlin
// and Python silently emitted nothing, and no scenario ever asked.
//
// Generated lane only — see the corpus README. One Postgres testcontainer per
// scenario (full isolation).

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CONTRACT_PROJECTION_DIR,
  API_CONTRACT_PROJECTION_SCENARIOS_DIR,
} from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedProjectionServer,
  type GeneratedProjectionServerHandle,
  type ProjectionSeed,
} from "../src/api-contract-projection-generated-server.ts";

const SEED = JSON.parse(
  readFileSync(join(API_CONTRACT_PROJECTION_DIR, "seed.json"), "utf8"),
) as ProjectionSeed;
const META_PATH = join(API_CONTRACT_PROJECTION_DIR, "meta.json");

describe("api contract projection (F22) — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_PROJECTION_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedProjectionServerHandle | null = null;
      try {
        server = await startGeneratedProjectionServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

async function runScenario(
  scenario: ApiScenario,
  server: GeneratedProjectionServerHandle,
): Promise<void> {
  for (const req of scenario.requests) {
    const init: RequestInit = { method: req.method };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await fetch(server.baseUrl + req.path, init);
    const bodyText = await res.text();
    let body: unknown = null;
    if (bodyText.length > 0) {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    assertResponse(scenario.name, req, res.status, body);
  }
}
