// #484 secret-fields api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/secret-fields/ over HTTP against the GENERATED
// Account routes: a `@formExclude` or credential (`view.password`) field is not writable
// through create / PATCH / PUT, and a credential is never returned. Generated lane only,
// like write-through/ and projection/ — see the corpus README. One Postgres testcontainer
// per scenario.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CONTRACT_SECRET_FIELDS_DIR,
  API_CONTRACT_SECRET_FIELDS_SCENARIOS_DIR,
} from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario, parseBodyExact } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedSecretFieldsServer,
  type GeneratedSecretFieldsServerHandle,
  type SecretFieldsSeed,
} from "../src/api-contract-secret-fields-generated-server.ts";

const SEED = JSON.parse(
  readFileSync(join(API_CONTRACT_SECRET_FIELDS_DIR, "seed.json"), "utf8"),
) as SecretFieldsSeed;
const META_PATH = join(API_CONTRACT_SECRET_FIELDS_DIR, "meta.json");

describe("api contract secret fields (#484) — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_SECRET_FIELDS_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedSecretFieldsServerHandle | null = null;
      try {
        server = await startGeneratedSecretFieldsServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }

  // The credential's write path cannot be observed over HTTP (a credential is never read), so
  // pin it on the emitted source: both marked fields are denied on write, only the credential
  // is hidden on read.
  test("generated route names the denied and hidden columns", async () => {
    const pg = await startPostgres();
    let server: GeneratedSecretFieldsServerHandle | null = null;
    try {
      server = await startGeneratedSecretFieldsServer(pg.connectionUri, META_PATH);
      expect(server.routesSource).toContain('writeDeniedColumns: ["tokenHash", "pinHash"]');
      expect(server.routesSource).toContain('hiddenColumns: ["pinHash"]');
    } finally {
      if (server) await server.close();
      await pg.stop();
    }
  }, { timeout: 60_000 });
});

async function runScenario(scenario: ApiScenario, server: GeneratedSecretFieldsServerHandle): Promise<void> {
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
