// #214 write-through read-your-writes api-contract conformance (GENERATED lane).
//
// Drives the fixtures/api-contract-conformance/write-through/ scenarios over HTTP
// against the GENERATED Order routes (the deployed artifact) — the emitted
// Order.routes.ts booted unmodified against a real Postgres testcontainer with the
// replica view v_order_with_customer present. This proves the deployed REST surface
// returns the derived customerName on read-your-writes (POST create's re-read + GET
// through the view) — the regression gate for the write-through-routes fix.
//
// Generated lane only: a hand-rolled reference server would re-implement the view
// join by hand and prove nothing about the emitted artifact (the thing that was
// broken). One Postgres testcontainer per scenario (full isolation).

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CONTRACT_WRITE_THROUGH_DIR,
  API_CONTRACT_WRITE_THROUGH_SCENARIOS_DIR,
} from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedWriteThroughServer,
  type GeneratedWriteThroughServerHandle,
  type WriteThroughSeed,
} from "../src/api-contract-write-through-generated-server.ts";

const SEED = JSON.parse(
  readFileSync(join(API_CONTRACT_WRITE_THROUGH_DIR, "seed.json"), "utf8"),
) as WriteThroughSeed;
const META_PATH = join(API_CONTRACT_WRITE_THROUGH_DIR, "meta.json");

describe("api contract write-through (#214) — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_WRITE_THROUGH_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedWriteThroughServerHandle | null = null;
      try {
        server = await startGeneratedWriteThroughServer(pg.connectionUri, META_PATH);
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
  server: GeneratedWriteThroughServerHandle,
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
