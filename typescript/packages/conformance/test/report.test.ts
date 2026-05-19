import { test, expect } from "bun:test";
import { emptyReport, mergeReports } from "../src/report.js";

test("emptyReport carries the language and zero fixtures", () => {
  const r = emptyReport("typescript");
  expect(r.language).toBe("typescript");
  expect(r.fixtures).toEqual([]);
});

test("mergeReports concatenates fixtures across languages", () => {
  const ts = emptyReport("typescript");
  ts.fixtures.push({ name: "a", checks: [], status: "pass" });
  const java = emptyReport("java");
  java.fixtures.push({ name: "a", checks: [], status: "known-gap" });
  const merged = mergeReports([ts, java]);
  expect(merged.map((r) => r.language)).toEqual(["java", "typescript"]);
});
