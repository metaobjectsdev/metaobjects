import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_REFERENCE_ATTR_REFERENCES, IDENTITY_SUBTYPE_REFERENCE, OBJECT_SUBTYPE_REPORT, TYPE_IDENTITY,
  pluralize, reportReadSource, reportShape, resolveTableName, toSnakeCase,
} from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadScenarios } from "../src/api-contract-scenario.ts";
import { generateReportApiSchemaSql } from "../src/api-contract-report-schema.ts";
import { SEED_REPORTS_KEY, seedInserts, type ReportSeed } from "../src/api-contract-report-generated-server.ts";
import {
  API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR, API_CONTRACT_REPORT_SCHEMA_SQL_PATH,
} from "../src/paths.ts";

const seed = JSON.parse(readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8")) as ReportSeed;
const seedReports = (): Record<string, Array<Record<string, unknown>>> => {
  if (seed.reports === undefined) throw new Error("seed.json has no reports");
  return seed.reports;
};

describe("api-contract report corpus", () => {
  test("the model loads and four of its five reports are view-backed", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const reports = root.objects().filter((o) => o.subType === OBJECT_SUBTYPE_REPORT);
    expect(reports.map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceDays", "ProductRevenue"]);
    expect(reports.filter((r) => reportReadSource(r) !== undefined).map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "ProductRevenue"]);
  });

  test("the route segments are the ones the scenarios call", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const segment = (name: string): string => pluralize(toSnakeCase(name));
    expect(["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "ProductRevenue"].map(segment)).toEqual(
      ["invoice_status_totals", "invoices_by_months", "invoice_totals", "product_revenues"]);
    expect(root.objects().length).toBe(8);
  });

  test("each seeded report row has exactly the report's derived fields", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    for (const [name, rows] of Object.entries(seedReports())) {
      const report = root.objects().find((o) => o.name === name);
      if (report === undefined) throw new Error(`seed.json names a report the model lacks: ${name}`);
      const fields = reportShape(report, root).fields.map((f) => f.name);
      for (const row of rows) expect(Object.keys(row)).toEqual(fields);
    }
    expect(Object.keys(seedReports())).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "ProductRevenue"]);
  });

  // A lane inserts every top-level key but `reports` in file order, so the order is the
  // contract: a table that references another comes after it.
  test("the base tables of seed.json are the model's tables, listed parents first", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const tables = Object.keys(seed).filter((k) => k !== SEED_REPORTS_KEY);
    expect(tables).toEqual(["invoices", "products", "sales"]);
    // Every key is an entity's table and every row key one of its fields (seedInserts throws otherwise).
    expect(seedInserts(root, seed).length).toBe(5 + 3 + 3);
    for (const [i, table] of tables.entries()) {
      const entity = root.objects().find((o) => o.isEntity() && resolveTableName(o) === table);
      if (entity === undefined) throw new Error(`no entity has table ${table}`);
      for (const ref of entity.children()) {
        if (ref.type !== TYPE_IDENTITY || ref.subType !== IDENTITY_SUBTYPE_REFERENCE) continue;
        const target = root.objects().find((o) => o.name === ref.attr(IDENTITY_REFERENCE_ATTR_REFERENCES));
        if (target === undefined) throw new Error(`${entity.name}.${ref.name} references no object`);
        expect(tables.indexOf(resolveTableName(target))).toBeLessThan(i);
        expect(tables.indexOf(resolveTableName(target))).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("every scenario parses, and there are sixteen", () => {
    const scenarios = loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR);
    expect(scenarios.length).toBe(16);
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
