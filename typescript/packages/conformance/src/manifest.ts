// Derived capability manifest — the distinct capability-ids the corpus invokes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import { parseOperationScript } from "./operation-script.js";

export interface Manifest {
  readonly version: 1;
  /** Sorted, distinct capability-ids exercised by the corpus. */
  readonly capabilities: string[];
}

/** Scan every script.json; collect the capability set. */
export function deriveManifest(fixtures: readonly Fixture[], _corpusRoot: string): Manifest {
  const caps = new Set<string>();
  for (const fix of fixtures) {
    if (!fix.hasScript) continue;
    const script = parseOperationScript(
      JSON.parse(readFileSync(join(fix.dir, "script.json"), "utf8")));
    for (const op of script.operations) caps.add(op.invoke);
  }
  return { version: 1, capabilities: [...caps].sort() };
}
