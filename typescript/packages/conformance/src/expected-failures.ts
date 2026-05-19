// Expected-failures ledger — the spec §4 three-rule classifier.

import { readFile } from "node:fs/promises";
import type { FixtureStatus } from "./report.js";

/** Apply the ledger to a raw pass/fail status. */
export function classifyAgainstLedger(
  raw: "pass" | "fail",
  fixtureName: string,
  ledger: readonly string[],
): FixtureStatus {
  const listed = ledger.includes(fixtureName);
  if (raw === "fail") return listed ? "known-gap" : "fail";
  return listed ? "fixed-but-listed" : "pass";
}

/** Load a port's ledger file; a missing file is an empty ledger. */
export async function loadLedger(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  } catch {
    return [];
  }
}

/** True when the run should fail CI: any `fail` or any `fixed-but-listed`. */
export function ledgerRunFailed(statuses: readonly FixtureStatus[]): boolean {
  return statuses.some((s) => s === "fail" || s === "fixed-but-listed");
}
