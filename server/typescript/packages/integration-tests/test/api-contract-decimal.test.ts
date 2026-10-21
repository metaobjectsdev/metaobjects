// ADR-0019 Amendment 1 api-contract conformance: a decimal is exact on the wire, GENERATED lane.
//
// Drives fixtures/api-contract-conformance/decimal/ over HTTP against the EMITTED routes of one
// writable entity and one served report, on Postgres, MySQL 8.4, SQLite and Cloudflare D1's local
// runtime. A scenario's `engines:` key says which engines run it (W4: only Postgres and MySQL hold
// 12345678901234567.89 exactly), and the `-15` scenarios are the subset every engine runs.
// Requires Docker for Postgres and MySQL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_DECIMAL_DIR, API_CONTRACT_DECIMAL_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, runScenario } from "../src/api-contract-scenario.ts";
import { startDecimalServer, type DecimalEngine } from "../src/api-contract-decimal-server.ts";
import type { ReportSeed } from "../src/api-contract-report-generated-server.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";
import { startPostgres } from "../src/postgres-container.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_DECIMAL_DIR, "seed.json"), "utf8")) as ReportSeed;
const META_PATH = join(API_CONTRACT_DECIMAL_DIR, "meta.json");
const ENGINES: readonly DecimalEngine[] = ["postgres", "mysql", "sqlite", "d1"];

let mysqlContainer: MysqlContainerHandle | undefined;
beforeAll(async () => { mysqlContainer = await startMysql(); }, 240_000);
afterAll(() => { mysqlContainer?.stop(); }, 60_000);

/** Run `fn` against a fresh server on `engine`, seeded with `seed`. Postgres gets its own container. */
async function withServer(
  engine: DecimalEngine,
  fn: (baseUrl: string) => Promise<void>,
  seed: ReportSeed = SEED,
): Promise<void> {
  if (engine === "postgres") {
    const pg = await startPostgres();
    try {
      const server = await startDecimalServer(engine, META_PATH, pg.connectionUri);
      try { await server.applySeed(seed); await fn(server.baseUrl); } finally { await server.close(); }
    } finally {
      await pg.stop();
    }
    return;
  }
  const server = await startDecimalServer(engine, META_PATH, engine === "mysql" ? mysqlContainer!.url : undefined);
  try { await server.applySeed(seed); await fn(server.baseUrl); } finally { await server.close(); }
}

const scenarios = loadScenarios(API_CONTRACT_DECIMAL_SCENARIOS_DIR);

for (const engine of ENGINES) describe(`api contract decimal (ADR-0019 Amendment 1) — GENERATED routes on ${engine}`, () => {
  for (const scenario of scenarios) {
    if (scenario.engines !== undefined && !scenario.engines.includes(engine)) continue;
    test(scenario.name, async () => {
      await withServer(engine, (baseUrl) => runScenario(scenario, baseUrl));
    }, { timeout: 120_000 });
  }

  // seed.json's `reports` half is what the seam lanes of the other ports serve in place of the view.
  // On the engines that hold the full seed exactly, the view's own answer must be that half.
  if (engine === "postgres" || engine === "mysql") {
    test("seed.json `reports` is exactly what the view answers", async () => {
      await withServer(engine, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/entry_totals?sort=bucket:asc`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(SEED.reports!["EntryTotals"]!);
      });
    }, { timeout: 120_000 });
  }

  test("a decimal is never a JSON number on the wire", async () => {
    await withServer(engine, async (baseUrl) => {
      const rows = (await (await fetch(`${baseUrl}/api/entries?filter[bucket][in]=A,D,E,F`)).json()) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(7);
      for (const row of rows) expect(row["amount"] === null || typeof row["amount"] === "string").toBe(true);
      const totals = (await (await fetch(`${baseUrl}/api/entry_totals?filter[bucket][in]=A,D,E,F`)).json()) as Array<Record<string, unknown>>;
      for (const row of totals) {
        for (const k of ["total", "totalOrZero", "mean", "top", "flaggedShare", "perFlagged"]) {
          expect(row[k] === null || typeof row[k] === "string").toBe(true);
        }
        expect(typeof row["entries"]).toBe("number");
      }
    });
  }, { timeout: 120_000 });
});
