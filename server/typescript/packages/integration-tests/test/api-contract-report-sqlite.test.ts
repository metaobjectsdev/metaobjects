// FR-044 view-backed-report api-contract conformance, GENERATED lane, on SQLite.
//
// The cross-port corpus (api-contract-report.test.ts) runs TypeScript against Postgres
// only, and its README does not assert a decimal's spelling. That left a hole on SQLite:
// a ratio is typed `decimal`, the TypeScript read schema types a decimal as `string`, and
// SQLite has no decimal, so the view hands the route a REAL. Unmodified, the generated
// route answered `"paidShare": 0.4` (a number) where Postgres answers `"paidShare": "0.4"`.
//
// This file boots the EMITTED report routes unmodified on a real SQLite (bun:sqlite) with
// the views the real lowering produces, and holds two things:
//   1. the type: a decimal is a JSON string on SQLite as it is on Postgres, null stays null,
//      and everything that is not a decimal keeps its type;
//   2. the shared scenarios: every scenario the Postgres lane runs also passes here, so
//      filtering, sorting and paging a decimal measure behave the same on both engines.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import type { ReportSeed } from "../src/api-contract-report-generated-server.ts";
import { startSqliteReportServer, type SqliteReportServerHandle } from "../src/api-contract-report-sqlite-server.ts";

const SEED = JSON.parse(readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8")) as ReportSeed;
const META_PATH = join(API_CONTRACT_REPORT_DIR, "meta.json");

async function withServer(fn: (server: SqliteReportServerHandle) => Promise<void>, seed: ReportSeed = SEED): Promise<void> {
  const server = await startSqliteReportServer(META_PATH);
  try {
    await server.applySeed(seed);
    await fn(server);
  } finally {
    await server.close();
  }
}

async function getJson(server: SqliteReportServerHandle, path: string): Promise<unknown> {
  const res = await fetch(server.baseUrl + path);
  expect(res.status).toBe(200);
  return res.json();
}

describe("api contract report (FR-044) — GENERATED routes on SQLite", () => {
  test("a ratio is a JSON string, as it is on Postgres, and the integers around it stay numbers", async () => {
    await withServer(async (server) => {
      const rows = (await getJson(server, "/api/invoice_totals")) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(typeof row["paidShare"]).toBe("string");
      expect(Number(row["paidShare"])).toBe(0.4);
      expect(row["invoices"]).toBe(5);
      expect(row["totalCents"]).toBe(315500);
    });
  });

  test("a ratio is a string in the withCount envelope too", async () => {
    await withServer(async (server) => {
      const body = (await getJson(server, "/api/invoice_totals?withCount=1")) as {
        rows: Array<Record<string, unknown>>; total: number;
      };
      expect(body.total).toBe(1);
      expect(typeof body.rows[0]!["paidShare"]).toBe("string");
    });
  });

  test("a ratio over zero rows is null, not the string 'null' or 0", async () => {
    await withServer(async (server) => {
      const rows = (await getJson(server, "/api/invoice_totals")) as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ invoices: 0, totalCents: null, paidShare: null }]);
    }, { invoices: [] });
  });

  test("a report with no decimal field is untouched: every value keeps its type", async () => {
    await withServer(async (server) => {
      expect(await getJson(server, "/api/invoice_status_totals?sort=status:asc")).toEqual(
        SEED.reports!["InvoiceStatusTotals"],
      );
      expect(await getJson(server, "/api/invoices_by_months?sort=issuedOnMonth:asc")).toEqual(
        SEED.reports!["InvoicesByMonth"],
      );
      expect(await getJson(server, "/api/product_revenues?sort=productId:asc")).toEqual(
        SEED.reports!["ProductRevenue"],
      );
    });
  });

  test("the filter and the sort on a ratio still compare numerically after the wire change", async () => {
    await withServer(async (server) => {
      const hit = async (path: string): Promise<number> => ((await getJson(server, path)) as unknown[]).length;
      expect(await hit("/api/invoice_totals?filter[paidShare][gt]=0.3")).toBe(1);
      expect(await hit("/api/invoice_totals?filter[paidShare][gt]=0.5")).toBe(0);
      // 0.4 < 0.5 numerically; as TEXT '0.5' would sort the other way against '0.45'-style values.
      expect(await hit("/api/invoice_totals?filter[paidShare][lt]=0.5")).toBe(1);
      expect(await hit("/api/invoice_totals?filter[paidShare][eq]=0.4")).toBe(1);
      expect(await hit("/api/invoice_totals?sort=paidShare:desc")).toBe(1);
    });
  });

  for (const scenario of loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR)) {
    test(`shared scenario: ${scenario.name}`, async () => {
      await withServer((server) => runScenario(scenario, server));
    });
  }
});

async function runScenario(scenario: ApiScenario, server: SqliteReportServerHandle): Promise<void> {
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
