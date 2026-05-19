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

// Fix 10: renderDashboard buckets `fixed-but-listed` into the Failing column
// alongside `fail`; verify this disjunct is actually exercised.
test("dashboard counts fixed-but-listed fixtures in the Failing column", () => {
  const report = emptyReport("rust");
  report.fixtures.push({ name: "x", checks: [], status: "pass" });
  report.fixtures.push({ name: "y", checks: [], status: "fixed-but-listed" });
  report.fixtures.push({ name: "z", checks: [], status: "fixed-but-listed" });
  const md = renderDashboard([report]);
  // 1 pass out of 3 total → "1/3 (33%)" in the Passing column
  expect(md).toContain("1/3 (33%)");
  // 2 fixed-but-listed → Failing column shows 2
  const row = md.split("\n").find((line) => line.includes("rust"))!;
  expect(row).toBeDefined();
  // The failing count is the last pipe-delimited cell in the row
  const cells = row.split("|").map((s) => s.trim());
  expect(cells.at(-2)).toBe("2");
});
