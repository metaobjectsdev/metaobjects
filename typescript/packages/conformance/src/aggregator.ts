// Report aggregator — N per-language reports → a CONFORMANCE.md dashboard.

import type { ConformanceReport } from "./report.js";
import { mergeReports } from "./report.js";

/** Render the unified dashboard markdown. */
export function renderDashboard(reports: ConformanceReport[]): string {
  const rows = mergeReports(reports).map((r) => {
    const total = r.fixtures.length;
    const pass = r.fixtures.filter((f) => f.status === "pass").length;
    const gap = r.fixtures.filter((f) => f.status === "known-gap").length;
    const fail = r.fixtures.filter(
      (f) => f.status === "fail" || f.status === "fixed-but-listed").length;
    const pct = total === 0 ? 0 : Math.round((pass / total) * 100);
    return `| ${r.language} | ${pass}/${total} (${pct}%) | ${gap} | ${fail} |`;
  });
  return [
    "# Conformance Dashboard", "",
    "| Language | Passing | Known gaps | Failing |",
    "|---|---|---|---|",
    ...rows, "",
  ].join("\n");
}
