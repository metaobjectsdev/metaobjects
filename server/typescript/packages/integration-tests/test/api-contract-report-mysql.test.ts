// FR-044 view-backed-report api-contract conformance, GENERATED lane, on MySQL 8.4.
//
// The cross-port corpus (api-contract-report.test.ts) runs the emitted routes on Postgres and
// api-contract-report-sqlite.test.ts on SQLite. This boots the same EMITTED report routes,
// unmodified, on a real MySQL with the views `buildReportViews({ dialect: "mysql" })` produces,
// and runs every shared scenario plus the seeded view rows. MySQL differs on the wire in the
// places the engine does: a ratio keeps its DECIMAL scale (`"0.4000"` where Postgres says
// `"0.4"`), so a decimal compares numerically, as the Postgres lane does. Requires Docker (or
// METAOBJECTS_TEST_MYSQL_URL).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import type { ReportSeed } from "../src/api-contract-report-generated-server.ts";
import { startMysqlReportServer, type MysqlReportServerHandle } from "../src/api-contract-report-mysql-server.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8")) as ReportSeed;
const META_PATH = join(API_CONTRACT_REPORT_DIR, "meta.json");

const SERVED_PATHS: Array<[string, string]> = [
  ["InvoiceStatusTotals", "/api/invoice_status_totals"],
  ["InvoicesByMonth", "/api/invoices_by_months"],
  ["InvoiceTotals", "/api/invoice_totals"],
  ["ProductRevenue", "/api/product_revenues"],
];

let container: MysqlContainerHandle;
beforeAll(async () => { container = await startMysql(); }, 240_000);
afterAll(() => { container?.stop(); }, 60_000);

async function withServer(fn: (server: MysqlReportServerHandle) => Promise<void>, seed: ReportSeed = SEED): Promise<void> {
  const server = await startMysqlReportServer(container.url, META_PATH);
  try {
    await server.applySeed(seed);
    await fn(server);
  } finally {
    await server.close();
  }
}

describe("api contract report (FR-044) — GENERATED routes on MySQL", () => {
  test("a ratio is a decimal string (MySQL keeps its scale), and the integers around it stay numbers", async () => {
    await withServer(async (server) => {
      const res = await fetch(server.baseUrl + "/api/invoice_totals");
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(typeof rows[0]!["paidShare"]).toBe("string");
      expect(Number(rows[0]!["paidShare"])).toBe(0.4);
      expect(rows[0]!["invoices"]).toBe(5);
      expect(rows[0]!["totalCents"]).toBe(315500);
    });
  }, { timeout: 120_000 });

  test("a ratio over zero rows is null", async () => {
    await withServer(async (server) => {
      const res = await fetch(server.baseUrl + "/api/invoice_totals");
      expect(await res.json()).toEqual([{ invoices: 0, totalCents: null, paidShare: null }]);
    }, { invoices: [] });
  }, { timeout: 120_000 });

  test("the seeded report rows are what the views return", async () => {
    await withServer(async (server) => {
      for (const [name, path] of SERVED_PATHS) {
        const res = await fetch(server.baseUrl + path);
        expect(res.status).toBe(200);
        const actual = (await res.json()) as Array<Record<string, unknown>>;
        const expected = SEED.reports![name]!;
        expect(actual.length).toBe(expected.length);
        const unmatched = [...actual];
        for (const want of expected) {
          const idx = unmatched.findIndex((got) => rowsEqual(got, want));
          if (idx < 0) throw new Error(`${name}: no returned row equals ${JSON.stringify(want)}; got ${JSON.stringify(actual)}`);
          unmatched.splice(idx, 1);
        }
      }
    });
  }, { timeout: 120_000 });

  for (const scenario of loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR)) {
    test(`shared scenario: ${scenario.name}`, async () => {
      await withServer((server) => runScenario(scenario, server));
    }, { timeout: 120_000 });
  }
});

/** paidShare compares numerically (a decimal's spelling is the engine's own); every other key strictly. */
function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a).sort();
  if (keys.join(",") !== Object.keys(b).sort().join(",")) return false;
  return keys.every((k) => (k === "paidShare" ? Number(a[k]) === Number(b[k]) : a[k] === b[k]));
}

async function runScenario(scenario: ApiScenario, server: MysqlReportServerHandle): Promise<void> {
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
