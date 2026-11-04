// api-contract conformance: a field.duration is an ISO-8601 span on the wire, GENERATED lane.
//
// Drives fixtures/api-contract-conformance/duration/ over HTTP against the EMITTED routes of one
// writable entity, on Postgres (a native interval), MySQL 8.4, SQLite and Cloudflare D1's local
// runtime (a BIGINT count of microseconds). The corpus pins "wire": { "durations": "iso" } in its
// own config. Requires Docker for Postgres and MySQL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CONTRACT_DURATION_DIR,
  API_CONTRACT_DURATION_MYSQL_SCHEMA_SQL_PATH,
  API_CONTRACT_DURATION_SCENARIOS_DIR,
  API_CONTRACT_DURATION_SCHEMA_SQL_PATH,
  API_CONTRACT_DURATION_SQLITE_SCHEMA_SQL_PATH,
} from "../src/paths.ts";
import { loadScenarios, runScenario } from "../src/api-contract-scenario.ts";
import { startGeneratedCorpusServer, type CorpusEngine, type GeneratedCorpusSpec } from "../src/api-contract-decimal-server.ts";
import type { ReportSeed } from "../src/api-contract-report-generated-server.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";
import { startPostgres } from "../src/postgres-container.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_DURATION_DIR, "seed.json"), "utf8")) as ReportSeed;
const META_PATH = join(API_CONTRACT_DURATION_DIR, "meta.json");
const ENGINES: readonly CorpusEngine[] = ["postgres", "mysql", "sqlite", "d1"];

const DURATION: GeneratedCorpusSpec = {
  name: "duration",
  served: ["Timer"],
  tables: ["timers"],
  mysqlViews: [],
  schemaPath: {
    postgres: API_CONTRACT_DURATION_SCHEMA_SQL_PATH,
    mysql: API_CONTRACT_DURATION_MYSQL_SCHEMA_SQL_PATH,
    sqlite: API_CONTRACT_DURATION_SQLITE_SCHEMA_SQL_PATH,
    d1: API_CONTRACT_DURATION_SQLITE_SCHEMA_SQL_PATH,
  },
};

let mysqlContainer: MysqlContainerHandle | undefined;
beforeAll(async () => { mysqlContainer = await startMysql(); }, 240_000);
afterAll(() => { mysqlContainer?.stop(); }, 60_000);

async function withServer(engine: CorpusEngine, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  if (engine === "postgres") {
    const pg = await startPostgres();
    try {
      const server = await startGeneratedCorpusServer(DURATION, engine, META_PATH, pg.connectionUri);
      try { await server.applySeed(SEED); await fn(server.baseUrl); } finally { await server.close(); }
    } finally {
      await pg.stop();
    }
    return;
  }
  const server = await startGeneratedCorpusServer(DURATION, engine, META_PATH, engine === "mysql" ? mysqlContainer!.url : undefined);
  try { await server.applySeed(SEED); await fn(server.baseUrl); } finally { await server.close(); }
}

const scenarios = loadScenarios(API_CONTRACT_DURATION_SCENARIOS_DIR);

test("the duration corpus has scenarios", () => { expect(scenarios.length).toBeGreaterThan(0); });

for (const engine of ENGINES) describe(`api contract duration — GENERATED routes on ${engine}`, () => {
  for (const scenario of scenarios) {
    if (scenario.engines !== undefined && !scenario.engines.includes(engine)) continue;
    test(scenario.name, async () => {
      await withServer(engine, (baseUrl) => runScenario(scenario, baseUrl));
    }, { timeout: 120_000 });
  }
});
