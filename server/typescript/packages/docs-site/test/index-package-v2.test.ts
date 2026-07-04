import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { CoverageTracker } from "../src/coverage";
import { buildIndexPage } from "../src/builders/index-data";
import { buildPackagePage } from "../src/builders/package-data";

const DIRS = [join(import.meta.dir, "fixture/input/acme")];

test("index shows hero flowchart + package cards carrying authored purpose", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  const d = buildIndexPage(g, new CoverageTracker(), { title: "Fixture", stamp: "2026-01-01", commit: "abc1234", sourceDirs: DIRS, core: { n: 15 } });
  // NOTE: brief Step-1 test said erDiagram but hero is now a flowchartDomain → corrected to "flowchart"
  expect(d.coreMermaid).toContain("flowchart");
  expect(d.dataPackages.find((c) => c.pkg === "acme::shop")?.purpose).toContain("orders");
});

test("package page carries authored prose + key-entity cards", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  const d = buildPackagePage("acme::shop", g, new CoverageTracker(), DIRS);
  expect(d.title).toBe("Shop");
  expect(d.descHtml).toContain("orders");
  expect(d.keyCards[0]?.name).toBe("Customer");
});
