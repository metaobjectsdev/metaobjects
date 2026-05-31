// Shared loader for the validation-conformance corpus cases.json.
// Every port's validator-parity runner reads the same single-source verdicts;
// this is the TS reference helper (other ports mirror it in their own language).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VALIDATION_DIR } from "./paths.ts";

/** One behavioral case: a payload and its expected accept/reject verdict. */
export interface ValidationCase {
  name: string;
  payload: Record<string, unknown>;
  expectValid: boolean;
}

/** Read fixtures/validation-conformance/cases.json. */
export function loadCases(): ValidationCase[] {
  const raw = readFileSync(join(VALIDATION_DIR, "cases.json"), "utf8");
  const parsed = JSON.parse(raw) as { cases: ValidationCase[] };
  return parsed.cases;
}
