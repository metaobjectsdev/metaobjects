import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, reportShape, type MetaObject, type MetaRoot } from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MODEL = join(REPO_ROOT, "fixtures", "conformance", "reporting-vocabulary", "input", "meta.shop.json");

async function load(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(MODEL).href]);
  expect(result.errors).toEqual([]);
  return result.root;
}
const report = (root: MetaRoot, name: string): MetaObject => {
  const found = root.objects().find((o) => o.name === name);
  if (found === undefined) throw new Error(`no object ${name}`);
  return found;
};
const brief = (root: MetaRoot, name: string) =>
  reportShape(report(root, name), root).fields.map((f) => [f.name, f.role, f.subType, f.required]);

describe("reportShape (FR-044 Table B)", () => {
  test("dimensions come first, in listed order, then measures", async () => {
    const root = await load();
    expect(brief(root, "ProgramEngagement")).toEqual([
      ["program", "dimension", "long", false],
      ["starters", "measure", "long", true],
      ["daysEngaged", "measure", "long", true],
      ["avgDaysPerStarter", "measure", "decimal", false],
      ["lastActivityAt", "measure", "timestamp", false],
    ]);
  });

  test("a time dimension derives <name><Grain> typed date", async () => {
    const root = await load();
    expect(brief(root, "DailyRevenue")).toEqual([
      ["purchasedAtDay", "dimension", "date", false],
      ["purchases", "measure", "long", true],
      ["revenue", "measure", "currency", false],
    ]);
  });

  test("sum of a currency keeps the currency field as its type source", async () => {
    const root = await load();
    const revenue = reportShape(report(root, "DailyRevenue"), root).fields.find((f) => f.name === "revenue");
    expect(revenue?.typeSource?.name).toBe("amountCents");
  });

  test("no dimensions yields measures only", async () => {
    const root = await load();
    expect(brief(root, "StoreTotals").map((f) => f[1])).toEqual(["measure", "measure", "measure"]);
  });
});
