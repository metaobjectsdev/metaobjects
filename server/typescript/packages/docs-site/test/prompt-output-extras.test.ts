import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { CoverageTracker } from "../src/coverage";
import { harvestComments } from "../src/yaml-comments";
import { buildPromptPage } from "../src/builders/prompt-data";
import { buildOutputPage } from "../src/builders/output-data";
import { buildEnumsPage, findAnomalies, buildSearchIndex } from "../src/builders/extras";

const DIRS = [join(import.meta.dir, "fixture/input/acme")];

test("prompt page: highlighted source, payload tree links, unresolved marks", async () => {
  const model = await loadModel(DIRS);
  const g = new LinkGraph(model);
  const d = buildPromptPage("acme::ai::npcReview", g, new CoverageTracker(), DIRS);
  expect(d.sourceHtml).toContain(`class="mu-com"`);
  expect(d.sourceHtml).toContain(`href="#f-npcName"`);
  expect(d.sourceHtml).toContain("mu-unresolved");            // {{{rawNotes}}}
  expect(d.payloadTree.some((r) => r.name === "npcName")).toBe(true);
  expect(d.tocHtml).toContain("items");
});

test("output page: wire classification + harvested comment (escaped)", async () => {
  const model = await loadModel(DIRS);
  const g = new LinkGraph(model);
  const docs = harvestComments(DIRS);
  const d = buildOutputPage("acme::ai::npcReviewOutput", g, new CoverageTracker(), docs, DIRS);
  expect(d.textRefResolves).toBe(false);
  expect(d.fields.find((f) => f.name === "reason")?.wire).toBe("@xmlText body");
  // note now comes from description attr (preferred over comment); must be escaped (XSS/corruption fix C1)
  const verdictNote = d.fields.find((f) => f.name === "verdict")?.note ?? "";
  // description attr: "verdict <b>tag</b> & \"quote\"" → all special chars escaped
  expect(verdictNote).toContain("&lt;b&gt;");
  expect(verdictNote).not.toContain("<b>");
  expect(verdictNote).toContain("&amp;");
  expect(verdictNote).toContain("&quot;");
});

test("output Meaning column reads authored description; prompt payload rows carry descriptions", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  const docs = harvestComments(DIRS);
  const out = buildOutputPage("acme::ai::npcReviewOutput", g, new CoverageTracker(), docs, DIRS);
  // fixture: `verdict` field carries description: "...<b>..." → escaped, non-empty, in note
  expect(out.fields.find((f) => f.name === "verdict")?.note).toContain("&lt;");
  const pr = buildPromptPage("acme::ai::npcReview", g, new CoverageTracker(), DIRS);
  expect(typeof pr.desc).toBe("string");
});

test("enums, anomalies, search index", async () => {
  const model = await loadModel(DIRS);
  const g = new LinkGraph(model);
  expect(buildEnumsPage(g).some((r) => r.owner === "Order" && r.values.includes("OPEN"))).toBe(true);
  const an = findAnomalies(g, DIRS);
  expect(an.some((a) => a.kind === "orphan" && a.subject === "OrphanLog")).toBe(true);
  expect(an.some((a) => a.kind === "unresolved-textref" && a.subject === "npcReviewOutput")).toBe(true);
  expect(buildSearchIndex(g).some((e) => e.k === "field" && e.t.includes("qty"))).toBe(true);
  // I3: composite-FK suppression -- orderId is part of a multi-field identity.reference, so no implied-ref
  expect(an.some((a) => a.kind === "implied-ref" && a.subject === "OrderLine.orderId")).toBe(false);
  // I3: unreachable-VO -- OrphanVO is in acme::ai (has templates) but unreachable from any payload tree
  expect(an.some((a) => a.kind === "unreachable-vo" && a.subject === "OrphanVO")).toBe(true);
});
