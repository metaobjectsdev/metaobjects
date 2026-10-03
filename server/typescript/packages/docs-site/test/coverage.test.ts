import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { CoverageTracker } from "../src/coverage";

test("unconsumed kinds and attrs are reported", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const cov = new CoverageTracker();
  for (const o of model.root.objects()) cov.consumeNode(o);   // consume objects only
  const rep = cov.report(model.root);
  const kind = (k: string) => rep.kinds.find((r) => r.key === k);
  expect(kind("object.entity")?.consumed).toBe(true);
  expect(kind("template.prompt")?.consumed).toBe(false);       // never consumed
  expect(rep.warnings.some((w) => w.includes("template.prompt"))).toBe(true);
});

test("attr consumption is tracked accurately", async () => {
  const model = await loadModel([join(import.meta.dir, "fixture/input/acme")]);
  const cov2 = new CoverageTracker();
  const first = model.root.objects()[0]!;
  const field = first.childrenOfType("field")[0]!;
  cov2.consumeAttr(field, "maxLength");
  const rep2 = cov2.report(model.root);
  expect(rep2.attrs.length).toBeGreaterThan(0);
  expect(rep2.attrs.every((r) => typeof r.key === "string")).toBe(true);
  const consumedAttr = rep2.attrs.find((r) => r.key === "field:@maxLength");
  expect(consumedAttr?.consumed).toBe(true);
});

test("FR-044 reporting vocabulary is reported as deferred, not as a rendering gap", async () => {
  // The inert model pair shared by every port's FR-044 Plan 1 inert test.
  const withReporting = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "codegen-noop", "reporting", "with");
  const model = await loadModel([withReporting]);
  const rep = new CoverageTracker().report(model.root);
  expect(rep.deferred.map((r) => r.key)).toEqual([
    "dimension.attribute", "dimension.time", "measure.aggregate", "measure.ratio", "object.report", "segment.filter",
  ]);
  // Never a "not rendered" row: the site renders none of it by design until Plan 2/3.
  const gapKeys = [...rep.kinds, ...rep.attrs].map((r) => r.key);
  expect(gapKeys.some((k) => /^(dimension|measure|segment)[.:]/.test(k) || k === "object.report")).toBe(false);
  expect(rep.warnings.filter((w) => w.includes("deferred (FR-044 Plan 2/3)")).length).toBe(6);
});
