import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OBJECT_SUBTYPE_REPORT, pluralize, reportReadSource, reportShape, toSnakeCase,
} from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadScenarios } from "../src/api-contract-scenario.ts";
import { generateReportApiSchemaSql } from "../src/api-contract-report-schema.ts";
import {
  API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR, API_CONTRACT_REPORT_SCHEMA_SQL_PATH,
} from "../src/paths.ts";

const seed = JSON.parse(readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8")) as {
  invoices: Array<Record<string, unknown>>;
  reports: Record<string, Array<Record<string, unknown>>>;
};

describe("api-contract report corpus", () => {
  test("the model loads and three of its four reports are view-backed", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const reports = root.objects().filter((o) => o.subType === OBJECT_SUBTYPE_REPORT);
    expect(reports.map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceDays"]);
    expect(reports.filter((r) => reportReadSource(r) !== undefined).map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"]);
  });

  test("the route segments are the ones the scenarios call", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const segment = (name: string): string => pluralize(toSnakeCase(name));
    expect(["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"].map(segment)).toEqual(
      ["invoice_status_totals", "invoices_by_months", "invoice_totals"]);
    expect(root.objects().length).toBe(5);
  });

  test("each seeded report row has exactly the report's derived fields", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    for (const [name, rows] of Object.entries(seed.reports)) {
      const report = root.objects().find((o) => o.name === name);
      if (report === undefined) throw new Error(`seed.json names a report the model lacks: ${name}`);
      const fields = reportShape(report, root).fields.map((f) => f.name);
      for (const row of rows) expect(Object.keys(row)).toEqual(fields);
    }
    expect(Object.keys(seed.reports)).toEqual(["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"]);
  });

  test("every scenario parses, and there are twelve", () => {
    const scenarios = loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR);
    expect(scenarios.length).toBe(12);
    for (const s of scenarios) expect(s.requests.length).toBeGreaterThan(0);
  });

  test("schema.postgres.sql is what TypeScript produces from meta.json", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const expected = await generateReportApiSchemaSql(root);
    const committed = readFileSync(API_CONTRACT_REPORT_SCHEMA_SQL_PATH, "utf8");
    if (committed !== expected) {
      throw new Error("report/schema.postgres.sql is stale. Run `bun run gen:report-api-schema` in integration-tests.");
    }
  });
});
