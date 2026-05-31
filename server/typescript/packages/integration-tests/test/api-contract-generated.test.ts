// bun:test entry — the GENERATED-routes api-contract lane.
//
// Mirrors api-contract.test.ts (the hand-rolled reference lane) one-for-one,
// but the server under test is the EMITTED Author.routes.ts artifact (Drizzle
// table + Zod schemas + filter/sort allowlists + drizzle-fastify
// mountCrudRoutes), booted over HTTP. Same corpus, same expects → proves the
// deployed artifact implements the cross-port contract, not just the
// golden-snapshot structure.
//
// One Postgres testcontainer per scenario (full isolation, matches the
// hand-rolled lane). Reuses the server-agnostic runner
// (loadScenarios/assertResponse).

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_DIR, API_CONTRACT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import {
  startGeneratedServer,
  type GeneratedServerHandle,
} from "../src/api-contract-generated-server.ts";
import { type AuthorRow } from "../src/api-contract-server.ts";
import { startPostgres } from "../src/postgres-container.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_DIR, "seed.json"), "utf8")) as { rows: AuthorRow[] };
const META_PATH = join(API_CONTRACT_DIR, "meta.json");

describe("api contract conformance — TS GENERATED routes runner", () => {
  for (const scenario of loadScenarios(API_CONTRACT_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedServerHandle | null = null;
      try {
        server = await startGeneratedServer(pg.connectionUri, META_PATH);
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

async function executeRequests(scenario: ApiScenario, server: GeneratedServerHandle): Promise<void> {
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
