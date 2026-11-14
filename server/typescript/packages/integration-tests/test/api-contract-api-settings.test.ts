// api-settings api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/api-settings/ over HTTP against the GENERATED Item
// routes, emitted under the corpus's `api` block: `pagination` (default 2, max 4) — a list with
// no limit answers the default page, a limit over the cap answers 400 limit_too_large — and
// `unknownFields: drop`, under which an undeclared body key is ignored instead of refused.
// Generated lane only — see the corpus README. One Postgres testcontainer per scenario.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_API_SETTINGS_DIR, API_CONTRACT_API_SETTINGS_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario, parseBodyExact } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedApiSettingsServer,
  type GeneratedApiSettingsServerHandle,
  type ApiSettingsSeed,
} from "../src/api-contract-api-settings-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_API_SETTINGS_DIR, "seed.json"), "utf8")) as ApiSettingsSeed;
const META_PATH = join(API_CONTRACT_API_SETTINGS_DIR, "meta.json");

describe("api contract api-settings — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_API_SETTINGS_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedApiSettingsServerHandle | null = null;
      try {
        server = await startGeneratedApiSettingsServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

async function runScenario(scenario: ApiScenario, server: GeneratedApiSettingsServerHandle): Promise<void> {
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
