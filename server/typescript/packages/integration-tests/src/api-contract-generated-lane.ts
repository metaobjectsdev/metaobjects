// The generated api-contract lane, shared by its two entry files: `api-contract-generated.test.ts`
// (the flat per-entity routes) and `api-contract-service.test.ts` (the service layer behind its
// thin Fastify transport, ADR-0067 layers 4 and 5). Same corpus, same expects, so the two
// servers cannot answer the contract differently.
//
// Flat layout: one Postgres testcontainer per scenario. Package layout: one container
// for the file and a fresh database per scenario. Reuses the server-agnostic runner
// (loadScenarios/assertResponse).

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_DIR, API_CONTRACT_SCENARIOS_DIR } from "./paths.ts";
import { openApiCheck, type ContractCheck } from "./api-contract-openapi-check.ts";
import { loadScenarios, assertResponse, type ApiScenario, parseBodyExact } from "./api-contract-scenario.ts";
import {
  startGeneratedServer,
  type GeneratedLane,
  type GeneratedServerHandle,
} from "./api-contract-generated-server.ts";
import { type AuthorRow } from "./api-contract-server.ts";
import { OUTPUT_LAYOUTS, postgresFor } from "./output-layout.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_DIR, "seed.json"), "utf8")) as { rows: AuthorRow[] };
const META_PATH = join(API_CONTRACT_DIR, "meta.json");

const contractCheck: ContractCheck = openApiCheck("blog");

/**
 * Run the corpus against one generated server: the flat routes, or (`api-contract-service.test.ts`)
 * the service layer behind its thin transport.
 */
export function describeGeneratedLane(lane: GeneratedLane, label: string): void {
  for (const layout of OUTPUT_LAYOUTS) describe(`api contract conformance — TS GENERATED ${label} runner [${layout}]`, () => {
    const startPostgres = postgresFor(layout);
    for (const scenario of loadScenarios(API_CONTRACT_SCENARIOS_DIR)) {
      test(scenario.name, async () => {
        const pg = await startPostgres();
        let server: GeneratedServerHandle | null = null;
        try {
          server = await startGeneratedServer(pg.connectionUri, META_PATH, layout, lane);
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
}


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
      try { body = parseBodyExact(bodyText); } catch { body = bodyText; }
    }
    assertResponse(scenario.name, req, res.status, body);
    contractCheck(req, res.status, bodyText);
  }
}
