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
  const first = model.root.objects()[0];
  const field = first.childrenOfType("field")[0];
  cov2.consumeAttr(field, "maxLength");
  const rep2 = cov2.report(model.root);
  expect(rep2.attrs.length).toBeGreaterThan(0);
  expect(rep2.attrs.every((r) => typeof r.key === "string")).toBe(true);
  const consumedAttr = rep2.attrs.find((r) => r.key === "field:@maxLength");
  expect(consumedAttr?.consumed).toBe(true);
});
