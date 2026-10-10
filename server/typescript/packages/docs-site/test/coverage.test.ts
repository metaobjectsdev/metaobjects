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

test("FR-044 reporting vocabulary is audited like any other kind: unrendered means a gap", async () => {
  // The inert model pair shared by every port's FR-044 tests. Nothing is consumed here, so
  // every reporting kind must surface as "not rendered" (it used to be parked as
  // "deferred" until the site rendered reports; test/reporting-site.test.ts shows the
  // real site consumes all of it).
  const withReporting = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "codegen-noop", "reporting", "with");
  const model = await loadModel([withReporting]);
  const rep = new CoverageTracker().report(model.root);
  expect("deferred" in rep).toBe(false);
  const reportingKinds = rep.kinds.filter((r) => /^(dimension|measure|segment)\./.test(r.key) || r.key === "object.report");
  expect(reportingKinds.map((r) => r.key)).toEqual([
    "dimension.attribute", "dimension.time", "measure.aggregate", "measure.ratio", "object.report", "segment.filter",
  ]);
  expect(reportingKinds.every((r) => !r.consumed)).toBe(true);
  expect(rep.warnings).toContain("coverage: object.report (4) not rendered by any page");
  // Unrendered too: the @spine of a report and the @default of a measure.
  expect(rep.attrs.find((r) => r.key === "object:@spine")).toEqual({ key: "object:@spine", count: 1, consumed: false });
  expect(rep.attrs.find((r) => r.key === "measure:@default")).toEqual({ key: "measure:@default", count: 1, consumed: false });
  expect(rep.warnings.some((w) => w.includes("deferred"))).toBe(false);
});
