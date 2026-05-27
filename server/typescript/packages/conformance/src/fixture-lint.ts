// Fixture-lint — validates a fixture before any port runs it (spec §2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import { parseOperationScript, parseExpectedErrors } from "./operation-script.js";

/**
 * Collect every `"name"` value that appears anywhere in a canonical
 * expected.json — used as a cheap over-approximation when checking that a
 * navigate path's colon-segment terminal exists.  Because this recurses into
 * attr/relationship bodies as well as node bodies, it can produce false-
 * negatives (a path may lint as clean even though the named node is absent),
 * but it never produces false-positives (a truly present node name is always
 * collected here).
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
    // Fix 1: use parseExpectedErrors for validated parsing instead of a blind cast.
    let envelope;
    try {
      envelope = parseExpectedErrors(
        JSON.parse(readFileSync(join(fix.dir, "expected-errors.json"), "utf8")));
    } catch (err) {
      problems.push(`${fix.name}: malformed expected-errors.json — ${(err as Error).message}`);
      return problems;
    }
    for (const { code } of envelope.errors) {
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
      // Fix 3a: recognize both segment grammars — `type:name` and `type[subType]`.
      const COLON_SEG = /^[a-z][a-z0-9-]*:[^[]+$/;
      const BRACKET_SEG = /^[a-z][a-z0-9-]*\[[a-zA-Z][a-zA-Z0-9-]*\]$/;
      for (const op of script.operations) {
        for (const segment of op.navigate) {
          if (BRACKET_SEG.test(segment)) {
            // Bracket segments (`type[subType]`) address nameless nodes — we
            // cannot cheaply verify existence against expected.json, so we
            // accept any syntactically valid bracket segment without emitting a
            // false "absent node" problem.
            continue;
          }
          if (!COLON_SEG.test(segment)) {
            // Neither colon nor bracket — malformed segment grammar.
            problems.push(
              `${fix.name}: navigate segment '${segment}' has malformed syntax `
                + `(expected 'type:name' or 'type[subType]')`);
            continue;
          }
          // Colon segment: check the named node exists in expected.json.
          const nodeName = segment.slice(segment.indexOf(":") + 1);
          if (!known.has(nodeName)) {
            problems.push(
              `${fix.name}: navigate segment '${segment}' names a node `
                + `absent from expected.json`);
          }
        }
      }
    }
  }
  return problems;
}
