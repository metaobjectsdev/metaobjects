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
        if (scenario.name === "write-ignores-excluded") await expectDeniedColumnsUntouched(server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }

  // The corpus README contract (a credential is never returned) on the two read paths the
  // corpus's Account routes do not reach: a projection field that extends `Account.pinHash`, and
  // an M:N traversal onto a TPH base whose subtype declares a credential.
  test("projection and M:N-onto-TPH reads never return an inherited credential", async () => {
    const pg = await startPostgres();
    let server: GeneratedSecretFieldsServerHandle | null = null;
    try {
      server = await startGeneratedSecretFieldsServer(pg.connectionUri, META_PATH);
      await server.applySeed(SEED);

      const list = await getJson(server, "/api/account_views");
      expect(list.map((r) => r.name)).toEqual(["Ada Lovelace", "Alan Turing"]);
      for (const row of list) expect(Object.keys(row)).not.toContain("pinHash");
      const one = (await getJson(server, "/api/account_views/1")) as unknown as Record<string, unknown>;
      expect(one.name).toBe("Ada Lovelace");
      expect(Object.keys(one)).not.toContain("pinHash");

      const auths = await getJson(server, "/api/payers/1/auths");
      expect(auths.map((r) => [r.id, r.type]).sort()).toEqual([[1, "Bridge"], [2, "Copay"]]);
      for (const row of auths) expect(Object.keys(row)).not.toContain("pinHash");
    } finally {
      if (server) await server.close();
      await pg.stop();
    }
  }, { timeout: 60_000 });
});

async function getJson(server: GeneratedSecretFieldsServerHandle, path: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(server.baseUrl + path);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

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

/** A credential is never read over HTTP, so prove the write was ignored on the stored rows. */
async function expectDeniedColumnsUntouched(server: GeneratedSecretFieldsServerHandle): Promise<void> {
  const stored = await server.storedRows();
  for (const seeded of SEED.rows) {
    expect(stored.find((r) => r.id === seeded.id)).toEqual({
      id: seeded.id,
      tokenHash: seeded.tokenHash,
      pinHash: seeded.pinHash,
    });
  }
  const created = stored.filter((r) => !SEED.rows.some((s) => s.id === r.id));
  expect(created.length).toBeGreaterThan(0);
  for (const row of created) expect(row).toMatchObject({ tokenHash: null, pinHash: null });
}
