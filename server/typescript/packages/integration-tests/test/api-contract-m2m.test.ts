// FR-018 Unit 10 — M:N traversal api-contract conformance (BOTH lanes).
//
// Drives the fixtures/api-contract-conformance/m2m/ scenarios (hetero,
// directed self-join, symmetric) over HTTP against:
//   1. the HAND-ROLLED reference server (api-contract-m2m-server.ts), and
//   2. the GENERATED routes artifact (api-contract-m2m-generated-server.ts) —
//      the emitted Post.routes.ts / Person.routes.ts booted unmodified.
//
// One Postgres testcontainer per scenario per lane (full isolation, mirrors the
// single-entity api-contract lanes). The two lanes share the same corpus +
// assertion runner, so a contract drift in either surfaces here.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_M2M_DIR, API_CONTRACT_M2M_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import { startM2mServer, type M2mServerHandle } from "../src/api-contract-m2m-server.ts";
import {
  startGeneratedM2mServer,
  type GeneratedM2mServerHandle,
  type M2mSeed,
} from "../src/api-contract-m2m-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_M2M_DIR, "seed.json"), "utf8")) as M2mSeed;
const META_PATH = join(API_CONTRACT_M2M_DIR, "meta.json");

interface Lane { baseUrl: string; applySeed(s: M2mSeed): Promise<void>; close(): Promise<void>; }

describe("api contract M:N — hand-rolled reference lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_M2M_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: M2mServerHandle | null = null;
      try {
        server = await startM2mServer(pg.connectionUri);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

describe("api contract M:N — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_M2M_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedM2mServerHandle | null = null;
      try {
        server = await startGeneratedM2mServer(pg.connectionUri, META_PATH);
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
