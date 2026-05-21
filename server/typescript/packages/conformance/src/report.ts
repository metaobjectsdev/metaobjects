// The shared conformance report schema. Every port's runner emits this; the
// aggregator (Task 13) merges N of them into CONFORMANCE.md.

export type CheckKind =
  | "expected" | "expected-effective" | "expected-errors" | "expected-warnings" | "operation";

export type FixtureStatus = "pass" | "fail" | "known-gap" | "fixed-but-listed";

export interface CheckResult {
  readonly kind: CheckKind;
  /** For an operation check: the operation index; otherwise undefined. */
  readonly operationIndex?: number;
  readonly passed: boolean;
  /** Human-readable mismatch detail when `passed` is false. */
  readonly detail?: string;
}

export interface FixtureReport {
  readonly name: string;
  readonly checks: CheckResult[];
  status: FixtureStatus;
  /** Capability-ids the operation checks exercised — feeds parity metrics. */
  capabilities?: string[];
}

export interface ConformanceReport {
  readonly language: string;
  readonly fixtures: FixtureReport[];
}

export function emptyReport(language: string): ConformanceReport {
  return { language, fixtures: [] };
}

/** Merge per-language reports; deterministic order (sorted by language). */
export function mergeReports(reports: ConformanceReport[]): ConformanceReport[] {
  return [...reports].sort((a, b) => a.language.localeCompare(b.language));
}
