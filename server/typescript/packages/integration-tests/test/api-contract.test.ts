// bun:test entry — one test per scenario in
// fixtures/api-contract-conformance/scenarios/.
//
// Each scenario spins up its own Postgres testcontainer + Fastify server
// (the runner spec — 1 container per scenario gives full isolation, mirrors
// the persistence-conformance runner shape, and keeps the failure surface
// per-test).
//
// Walks scenarios/*.yaml; for each one, applies the seed (or truncates
// when setup.truncate is true), executes the ordered request list via
// fastify.inject(), and asserts each response against the inline expect block.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_DIR, API_CONTRACT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startServer, type ServerHandle, type AuthorRow } from "../src/api-contract-server.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { startPostgres } from "../src/postgres-container.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_DIR, "seed.json"), "utf8")) as { rows: AuthorRow[] };

describe("api contract conformance — TS Fastify reference runner", () => {
  for (const scenario of loadScenarios(API_CONTRACT_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: ServerHandle | null = null;
      try {
        const root = await loadMetadataFile(join(API_CONTRACT_DIR, "meta.json"));
        server = await startServer(pg.connectionUri, root);
        if (scenario.setup?.truncate) await server.truncate();
        else await server.applySeed(SEED.rows);

        await executeRequests(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

async function executeRequests(scenario: ApiScenario, server: ServerHandle): Promise<void> {
  for (const req of scenario.requests) {
    // Only set content-type when there's a body — Fastify rejects
    // `Content-Type: application/json` with no body as FST_ERR_CTP_EMPTY_JSON_BODY.
    const init: RequestInit = { method: req.method };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await fetch(server.baseUrl + req.path, init);
    // 204 carries no body; everything else is JSON.
    const bodyText = await res.text();
    let body: unknown = null;
    if (bodyText.length > 0) {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    assertResponse(scenario.name, req, res.status, body);
  }
}
