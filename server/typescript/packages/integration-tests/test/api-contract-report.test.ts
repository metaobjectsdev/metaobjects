// FR-044 view-backed-report api-contract conformance (GENERATED lane).
//
// Drives fixtures/api-contract-conformance/report/ over HTTP against the GENERATED
// report routes — the emitted <Report>.routes.ts files booted unmodified against a
// real Postgres testcontainer, with the views the real lowering produces. Generated
// lane only — see the corpus README. One Postgres testcontainer per scenario.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR } from "../src/paths.ts";
import { loadScenarios, assertResponse, type ApiScenario } from "../src/api-contract-scenario.ts";
import { startPostgres } from "../src/postgres-container.ts";
import {
  startGeneratedReportServer,
  type GeneratedReportServerHandle,
  type ReportSeed,
} from "../src/api-contract-report-generated-server.ts";

const SEED = JSON.parse(
  readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8"),
) as ReportSeed;
const META_PATH = join(API_CONTRACT_REPORT_DIR, "meta.json");

const SERVED_PATHS: Array<[string, string]> = [
  ["InvoiceStatusTotals", "/api/invoice_status_totals"],
  ["InvoicesByMonth", "/api/invoices_by_months"],
  ["InvoiceTotals", "/api/invoice_totals"],
  ["ProductRevenue", "/api/product_revenues"],
];

describe("api contract report (FR-044) — GENERATED routes lane", () => {
  for (const scenario of loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR)) {
    test(scenario.name, async () => {
      const pg = await startPostgres();
      let server: GeneratedReportServerHandle | null = null;
      try {
        server = await startGeneratedReportServer(pg.connectionUri, META_PATH);
        await server.applySeed(SEED);
        await runScenario(scenario, server);
      } finally {
        if (server) await server.close();
        await pg.stop();
      }
    }, { timeout: 60_000 });
  }

  test("the seeded report rows are what the views return", async () => {
    const pg = await startPostgres();
    let server: GeneratedReportServerHandle | null = null;
    try {
      server = await startGeneratedReportServer(pg.connectionUri, META_PATH);
      await server.applySeed(SEED);
      for (const [name, path] of SERVED_PATHS) {
        const res = await fetch(server.baseUrl + path);
        expect(res.status).toBe(200);
        const actual = (await res.json()) as Array<Record<string, unknown>>;
        const expected = SEED.reports?.[name];
        if (expected === undefined) throw new Error(`seed.json has no reports.${name}`);
        expect(actual.length).toBe(expected.length);
        const unmatched = [...actual];
        for (const want of expected) {
          const idx = unmatched.findIndex((got) => rowsEqual(got, want));
          if (idx < 0) {
            throw new Error(
              `${name}: no returned row equals ${JSON.stringify(want)}; got ${JSON.stringify(actual)}`,
            );
          }
          unmatched.splice(idx, 1);
        }
      }
    } finally {
      if (server) await server.close();
      await pg.stop();
    }
  }, { timeout: 60_000 });
});

/** paidShare compares numerically (a decimal's spelling is the port's own); every other
 *  key by strict equality. */
function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.join(",") !== keysB.join(",")) return false;
  return keysA.every((k) =>
    k === "paidShare" ? Number(a[k]) === Number(b[k]) : a[k] === b[k],
  );
}

async function runScenario(
  scenario: ApiScenario,
  server: GeneratedReportServerHandle,
): Promise<void> {
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
