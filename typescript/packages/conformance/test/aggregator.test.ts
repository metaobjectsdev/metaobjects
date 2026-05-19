import { test, expect } from "bun:test";
import { renderDashboard } from "../src/aggregator.js";
import { emptyReport } from "../src/report.js";

test("dashboard reports per-language pass and known-gap counts", () => {
  const ts = emptyReport("typescript");
  ts.fixtures.push({ name: "a", checks: [], status: "pass" });
  const java = emptyReport("java");
  java.fixtures.push({ name: "a", checks: [], status: "pass" });
  java.fixtures.push({ name: "b", checks: [], status: "known-gap" });
  const md = renderDashboard([ts, java]);
  expect(md).toMatch(/typescript/);
  expect(md).toMatch(/java/);
  expect(md).toMatch(/known-gap|known gap/i);
});
