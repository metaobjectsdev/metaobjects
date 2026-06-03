// FR-017 Tier 5 — TPH polymorphic CRUD api-contract conformance (BOTH lanes).
//
// Drives the fixtures/api-contract-conformance/tph/ scenarios (polymorphic
// list/get, per-subtype list/create, per-subtype update/delete, cross-subtype
// 404) over HTTP against:
//   1. the HAND-ROLLED reference server (api-contract-tph-server.ts), and
//   2. the GENERATED routes artifact (api-contract-tph-generated-server.ts) —
//      the emitted Auth.routes.ts booted unmodified.
//
// One Postgres testcontainer per scenario per lane (full isolation, mirrors the
// single-entity + M:N api-contract lanes). The two lanes share the same corpus
// + assertion runner, so a contract drift in either surfaces here.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_TPH_DIR, API_CONTRACT_TPH_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import { startTphServer, type TphServerHandle } from "../src/api-contract-tph-server.ts";
import {
  startGeneratedTphServer,
  type GeneratedTphServerHandle,
  type TphSeed,
} from "../src/api-contract-tph-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_TPH_DIR, "seed.json"), "utf8")) as TphSeed;
const META_PATH = join(API_CONTRACT_TPH_DIR, "meta.json");

interface Lane { baseUrl: string; applySeed(s: TphSeed): Promise<void>; close(): Promise<void>; }

describe("api contract TPH — hand-rolled reference lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_TPH_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: TphServerHandle | null = null;
      try {
        server = await startTphServer(pg.connectionUri);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

describe("api contract TPH — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_TPH_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedTphServerHandle | null = null;
      try {
        server = await startGeneratedTphServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

async function runScenario(scenario: ApiScenario, server: Lane): Promise<void> {
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
