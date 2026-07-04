import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { CoverageTracker } from "../src/coverage";
import { buildObjectPage } from "../src/builders/object-data";

test("Order page: extends chain, own vs inherited, constraints, backlinks", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const g = new LinkGraph(model);
  const d = buildObjectPage("acme::shop::Order", g, new CoverageTracker());
  // extendsChain → hierarchy: ancestors appear as non-self rows above the self row
  const selfLevel = d.hierarchy.find((h) => h.self)!.level;
  expect(d.hierarchy.filter((h) => !h.self && h.level < selfLevel).map((h) => h.name)).toEqual(["BaseEntity"]);
  expect(d.ownFields.map((f) => f.name)).toEqual(["status", "qty", "customerId"]);
  expect(d.inheritedFields.map((f) => f.name)).toEqual(["id", "createdAt"]);
  expect(d.inheritedFields[0]!.inheritedFrom?.name).toBe("BaseEntity");
  const status = d.ownFields[0]!;
  // constraintsHtml → badgesHtml; enum values are now in enumValues array not injected into badges
  expect(status.enumValues.map((e) => e.value)).toContain("OPEN");
  expect(status.badgesHtml).toContain("default OPEN");
  const qty = d.ownFields[1]!;
  expect(qty.badgesHtml).toContain("min=1");
  expect(d.references.some((r) => r.name === "Customer")).toBe(true);
  expect(d.tableName).toBe("orders");
});

test("ItemView page: used-by-templates backlink through the payload tree", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const g = new LinkGraph(model);
  const d = buildObjectPage("acme::ai::ItemView", g, new CoverageTracker());
  expect(d.usedByTemplates.map((t) => t.name)).toContain("npcReview");
});
