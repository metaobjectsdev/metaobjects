// list-query api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/list-query/ over HTTP against the GENERATED Part
// routes: what a parsed list query matches in a real store (search ignores case, `like` does
// not; or/and; the nesting cap; bare fields; leading wildcards; value formats; paging past 50)
// and the body, id and constraint refusals. The parse itself is pinned with no server by
// fixtures/list-query-conformance/. Generated lane only — see the corpus README.
//
// One Postgres testcontainer for the file, reseeded before every scenario: no scenario
// depends on another's writes, and a container per scenario is twenty container starts.

import { afterAll, beforeAll, describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_LIST_QUERY_DIR, API_CONTRACT_LIST_QUERY_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, runScenario } from "../src/api-contract-scenario.ts";
import { openApiCheck } from "../src/api-contract-openapi-check.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedListQueryServer,
  type GeneratedListQueryServerHandle,
  type ListQuerySeed,
} from "../src/api-contract-list-query-generated-server.ts";
import { API_LANES, laneLabel } from "../src/api-lane.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_LIST_QUERY_DIR, "seed.json"), "utf8")) as ListQuerySeed;
const META_PATH = join(API_CONTRACT_LIST_QUERY_DIR, "meta.json");
// Every exchange is also held to the OpenAPI document for this model (contract corpus case
// `list-query`): a search or combinator the routes serve must be one the document states. `cb`
// is the cache-buster bare-unknown-parameter-ignored sends: the contract ignores it, so the
// document rightly does not state it.
const contractCheck = openApiCheck("list-query", { ignoredQuery: ["cb"] });

for (const lane of API_LANES) describe(`api contract list-query — ${laneLabel(lane)}`, () => {
  let pg: Awaited<ReturnType<typeof startPostgres>> | null = null;
  let server: GeneratedListQueryServerHandle | null = null;

  beforeAll(async () => {
    pg = await startPostgres();
    server = await startGeneratedListQueryServer(pg.connectionUri, META_PATH, lane);
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (pg) await pg.stop();
  });

  for (const scenario of loadScenarios(API_CONTRACT_LIST_QUERY_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      await server!.applySeed(SEED);
      await runScenario(scenario, server!.baseUrl, contractCheck);
    }, { timeout: 60_000 });
  }
});
