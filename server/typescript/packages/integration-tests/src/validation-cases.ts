// Shared loader for the validation-conformance corpus cases.json.
// Every port's validator-parity runner reads the same single-source verdicts;
// this is the TS reference helper (other ports mirror it in their own language).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VALIDATION_DIR } from "./paths.ts";

/** The entity a case is validated against when it names none. */
export const DEFAULT_VALIDATION_ENTITY = "Account";

/** One behavioral case: a payload and its expected accept/reject verdict. */
export interface ValidationCase {
  name: string;
  /** Corpus entity whose generated insert artifact validates this payload.
   *  Absent means `Account`, which every pre-existing case uses. A case naming a
   *  different entity (e.g. `Ledger`, whose primary key is ASSIGNED rather than
   *  `@generation`-backed) needs a shape `Account` cannot express. */
  entity?: string;
  payload: Record<string, unknown>;
  expectValid: boolean;
}

/** Read fixtures/validation-conformance/cases.json. */
export function loadCases(): ValidationCase[] {
  const raw = readFileSync(join(VALIDATION_DIR, "cases.json"), "utf8");
  const parsed = JSON.parse(raw) as { cases: ValidationCase[] };
  return parsed.cases;
}
