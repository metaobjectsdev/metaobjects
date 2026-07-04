import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { CoverageTracker } from "../src/coverage";
import { buildObjectPage } from "../src/builders/object-data";

const DIRS = [join(import.meta.dir, "fixture/input/acme")];

test("object page surfaces validators, indexes detail, relations, generation, description, inheritance", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  const d = buildObjectPage("acme::shop::Order", g, new CoverageTracker());
  expect(d.desc).toContain("&lt;");                                 // fixture desc with < is escaped
  expect(d.generation).toBe("uuid");                                 // identity.primary generation
  expect(d.validators.some((v) => v.scope === "object" && v.rule.includes("qty"))).toBe(true); // comparison qty<=99
  expect(d.indexes.some((i) => i.extra.includes("where") || i.extra.includes("orders"))).toBe(true);
  expect(d.relations.some((r) => r.toName === "Customer" && r.cardinality === "one")).toBe(true);
  expect(d.ownFields.find((f) => f.name === "status")?.enumValues.length).toBeGreaterThan(0);
  expect(d.hierarchy.some((h) => h.self) && d.hierarchy.some((h) => h.name === "BaseEntity")).toBe(true);
  expect(d.inheritanceMermaid).toContain("flowchart TD");
});

test("projection object marks view + origin provenance", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  const d = buildObjectPage("acme::shop::LineItemView", g, new CoverageTracker());
  expect(d.isView).toBe(true);
  expect(d.origins.some((o) => o.field === "customerName")).toBe(true);
});
