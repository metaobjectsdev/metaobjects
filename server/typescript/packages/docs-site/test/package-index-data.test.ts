import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { CoverageTracker } from "../src/coverage";
import { buildPackagePage } from "../src/builders/package-data";
import { buildIndexPage } from "../src/builders/index-data";

test("package page: abstracts grouped, ERD variants, prompt rows", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const g = new LinkGraph(model);
  const shop = buildPackagePage("acme::shop", g, new CoverageTracker());
  expect(shop.objects.map((o) => o.name)).toEqual(["Customer", "LineItemView", "Order", "OrphanLog"]);
  // v2: single erdMermaid replaces the erdInternal/erdExternals toggle
  expect(shop.erdMermaid).toContain("Customer");
  expect(shop.erdMermaid).toContain("Order");
  expect(shop.erdLegend.some((l) => l.pkg === "acme::shop")).toBe(true);
  const common = buildPackagePage("acme::common", g, new CoverageTracker());
  expect(common.abstracts.map((o) => o.name)).toEqual(["BaseEntity"]);
  const ai = buildPackagePage("acme::ai", g, new CoverageTracker());
  expect(ai.prompts.map((t) => t.name)).toEqual(["npcReview"]);
  expect(ai.outputs.map((t) => t.name)).toEqual(["npcReviewOutput"]);
});

test("index page: stats, hero flowchart, package cards", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const g = new LinkGraph(model);
  const d = buildIndexPage(g, new CoverageTracker(), { title: "Fixture", stamp: "S", commit: "C", core: { n: 2 } });
  expect(d.stats.objects).toBe(10);
  expect(d.stats.contracts).toBe(1);
  expect(d.coreMermaid).toContain("flowchart");        // hero is now a domain-colored flowchart
  expect(d.coreCaption).toContain("most-connected");   // connected-cluster core map (all object types)
  expect(d.promptPackages.map((p) => p.pkg)).toEqual(["acme::ai"]);
});
