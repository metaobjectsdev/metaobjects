// jsonb open-bag parsed-value api-contract conformance (BOTH lanes).
//
// Drives the fixtures/api-contract-conformance/jsonb/ scenario over HTTP
// against:
//   1. the HAND-ROLLED reference server (api-contract-jsonb-server.ts), and
//   2. the GENERATED routes artifact (api-contract-jsonb-generated-server.ts) —
//      the emitted Document.routes.ts booted unmodified.
//
// The contract: a `field.string @dbColumnType:jsonb` open bag accepts a posted
// JSON object and reads it back as the same object (never a JSON-encoded
// string). One Postgres testcontainer per scenario per lane (full isolation,
// mirrors the single-entity + m2m lanes).

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_JSONB_DIR, API_CONTRACT_JSONB_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { startJsonbServer, type JsonbServerHandle, type DocumentRow } from "../src/api-contract-jsonb-server.ts";
import {
  startGeneratedJsonbServer,
  type GeneratedJsonbServerHandle,
} from "../src/api-contract-jsonb-generated-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_JSONB_DIR, "seed.json"), "utf8")) as { rows: DocumentRow[] };
const META_PATH = join(API_CONTRACT_JSONB_DIR, "meta.json");

interface Lane { baseUrl: string; applySeed(rows: DocumentRow[]): Promise<void>; close(): Promise<void>; }

describe("api contract jsonb open-bag — hand-rolled reference lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_JSONB_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: JsonbServerHandle | null = null;
      try {
        const root = await loadMetadataFile(META_PATH);
        server = await startJsonbServer(pg.connectionUri, root);
        await server.applySeed(SEED.rows);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }
});

describe("api contract jsonb open-bag — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_JSONB_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedJsonbServerHandle | null = null;
      try {
        server = await startGeneratedJsonbServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED.rows);
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
