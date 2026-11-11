// enum-default api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/enum-default/ over HTTP against the GENERATED
// Ticket routes: a create that omits a defaulted enum stores the default, and a supplied member
// is kept. Generated lane only — see the corpus README. One Postgres testcontainer per scenario.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_ENUM_DEFAULT_DIR, API_CONTRACT_ENUM_DEFAULT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario, parseBodyExact } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedEnumDefaultServer,
  type GeneratedEnumDefaultServerHandle,
  type EnumDefaultSeed,
} from "../src/api-contract-enum-default-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_ENUM_DEFAULT_DIR, "seed.json"), "utf8")) as EnumDefaultSeed;
const META_PATH = join(API_CONTRACT_ENUM_DEFAULT_DIR, "meta.json");

describe("api contract enum default — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_ENUM_DEFAULT_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedEnumDefaultServerHandle | null = null;
      try {
        server = await startGeneratedEnumDefaultServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

async function runScenario(scenario: ApiScenario, server: GeneratedEnumDefaultServerHandle): Promise<void> {
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
  }
}
