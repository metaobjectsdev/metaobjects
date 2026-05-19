// Fixture-lint — validates a fixture before any port runs it (spec §2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import { parseOperationScript } from "./operation-script.js";

/**
 * Collect every node name that appears in a canonical expected.json — used to
 * cheaply check that a navigate path's terminal node exists in the resolved
 * tree. (A wrapper key is `type.subType`; the body's `name` is the node name.)
 */
function namesIn(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) namesIn(v, acc); return; }
  if (typeof value !== "object" || value === null) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "name" && typeof v === "string") acc.add(v);
    else namesIn(v, acc);
  }
}

/** Lint one fixture; return a list of problem strings (empty = clean). */
export function lintFixture(fix: Fixture, errorCodes: readonly string[]): string[] {
  const problems: string[] = [];

  if (fix.hasExpectedErrors) {
    const codes = JSON.parse(
      readFileSync(join(fix.dir, "expected-errors.json"), "utf8")) as { code: string }[];
    for (const { code } of codes) {
      if (!errorCodes.includes(code)) {
        problems.push(`${fix.name}: unregistered error code '${code}'`);
      }
    }
  }

  if (fix.hasScript) {
    let script;
    try {
      script = parseOperationScript(
        JSON.parse(readFileSync(join(fix.dir, "script.json"), "utf8")));
    } catch (err) {
      problems.push(`${fix.name}: malformed script.json — ${(err as Error).message}`);
      return problems;
    }
    if (fix.hasExpected) {
      const known = new Set<string>();
      namesIn(JSON.parse(readFileSync(join(fix.dir, "expected.json"), "utf8")), known);
      for (const op of script.operations) {
        for (const segment of op.navigate) {
          const colon = segment.indexOf(":");
          if (colon !== -1) {
            const nodeName = segment.slice(colon + 1);
            if (!known.has(nodeName)) {
              problems.push(
                `${fix.name}: navigate segment '${segment}' names a node `
                  + `absent from expected.json`);
            }
          }
        }
      }
    }
  }
  return problems;
}
