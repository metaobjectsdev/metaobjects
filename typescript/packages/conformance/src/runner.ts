// The runner engine — runs one fixture's checks through a ConformanceAdapter.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import type { ConformanceAdapter } from "./adapter.js";
import { UnknownCapabilityError } from "./adapter.js";
import { parseOperationScript, parseExpectedErrors } from "./operation-script.js";
import { resultsEqual, type NormalizedResult } from "./result.js";
import type { CheckResult, FixtureReport } from "./report.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Run every check a fixture declares; produce its FixtureReport. */
export async function runFixture(
  fix: Fixture,
  adapter: ConformanceAdapter,
): Promise<FixtureReport> {
  const checks: CheckResult[] = [];
  const capabilities: string[] = [];
  const outcome = await adapter.loadFixture(fix.inputDir, fix.providers);

  if (fix.hasExpectedErrors) {
    // Fix 1: use parseExpectedErrors — throws a clear Error on malformed input.
    // Fix 2: wrap the read+parse so a bad file produces a failed check, not a throw.
    let want: string[] | undefined;
    try {
      want = parseExpectedErrors(await readJson(join(fix.dir, "expected-errors.json")))
        .map((e) => e.code)
        .sort();
    } catch (err) {
      checks.push({
        kind: "expected-errors",
        passed: false,
        detail: `expected-errors.json parse error: ${(err as Error).message}`,
      });
    }
    if (want !== undefined) {
      const got = [...outcome.errorCodes].sort();
      const passed = want.length === got.length && want.every((c, i) => c === got[i]);
      checks.push({
        kind: "expected-errors",
        passed,
        ...(passed ? {} : { detail: `expected [${want}], got [${got}]` }),
      });
    }
  }

  // If the load produced no tree but tree-dependent checks are expected, push a
  // synthetic failed check so the report is self-explanatory rather than silent.
  if (
    outcome.tree === undefined &&
    (fix.hasExpected || fix.hasExpectedEffective || fix.hasScript)
  ) {
    checks.push({
      kind: "expected",
      passed: false,
      detail: "load produced no tree — cannot run tree-dependent checks",
    });
  }

  // Fix 6: hoist tree after the undefined guard so tree-dependent blocks never
  // need outcome.tree! non-null assertions.
  if (fix.hasExpected && outcome.tree !== undefined) {
    const tree = outcome.tree;
    let want: string | undefined;
    try {
      // Fix 2: wrap file read so parse errors become failed checks, not throws.
      want = (await readFile(join(fix.dir, "expected.json"), "utf8")).trim();
    } catch (err) {
      checks.push({
        kind: "expected",
        passed: false,
        detail: `expected.json read error: ${(err as Error).message}`,
      });
    }
    if (want !== undefined) {
      const got = adapter.canonicalSerialize(tree).trim();
      const passed = want === got;
      checks.push({
        kind: "expected",
        passed,
        ...(passed ? {} : { detail: "canonical serialization mismatch" }),
      });
    }
  }

  if (fix.hasExpectedEffective && outcome.tree !== undefined) {
    const tree = outcome.tree;
    let want: string | undefined;
    try {
      // Fix 2: wrap file read so parse errors become failed checks, not throws.
      want = (await readFile(join(fix.dir, "expected-effective.json"), "utf8")).trim();
    } catch (err) {
      checks.push({
        kind: "expected-effective",
        passed: false,
        detail: `expected-effective.json read error: ${(err as Error).message}`,
      });
    }
    if (want !== undefined) {
      const got = adapter.canonicalSerializeEffective(tree).trim();
      const passed = want === got;
      checks.push({
        kind: "expected-effective",
        passed,
        ...(passed ? {} : { detail: "effective serialization mismatch" }),
      });
    }
  }

  if (fix.hasScript && outcome.tree !== undefined) {
    const tree = outcome.tree;
    let script: ReturnType<typeof parseOperationScript> | undefined;
    try {
      // Fix 2: wrap script parse so malformed script.json produces a failed check.
      script = parseOperationScript(await readJson(join(fix.dir, "script.json")));
    } catch (err) {
      checks.push({
        kind: "operation",
        operationIndex: 0,
        passed: false,
        detail: `script.json parse error: ${(err as Error).message}`,
      });
    }
    if (script !== undefined) {
      script.operations.forEach((op, i) => {
        if (!capabilities.includes(op.invoke)) capabilities.push(op.invoke);
        const node = adapter.navigate(tree, op.navigate);
        if (node === undefined) {
          checks.push({
            kind: "operation",
            operationIndex: i,
            passed: false,
            detail: `navigate [${op.navigate}] did not resolve`,
          });
          return;
        }
        let actual: NormalizedResult;
        try {
          actual = adapter.invoke(node, op.invoke, op.args ?? {});
        } catch (err) {
          const detail = err instanceof UnknownCapabilityError
            ? `unbound capability '${op.invoke}'`
            : `invoke threw: ${(err as Error).message}`;
          checks.push({ kind: "operation", operationIndex: i, passed: false, detail });
          return;
        }
        const passed = resultsEqual(actual, op.expect);
        checks.push({
          kind: "operation",
          operationIndex: i,
          passed,
          ...(passed ? {} : { detail: `expected ${JSON.stringify(op.expect)}, got ${JSON.stringify(actual)}` }),
        });
      });
    }
  }

  // A fixture with no expectation files at all is a configuration error — push an
  // explanatory failed check so the report is never a bare empty "fail".
  if (
    checks.length === 0 &&
    !fix.hasExpected &&
    !fix.hasExpectedEffective &&
    !fix.hasExpectedErrors &&
    !fix.hasScript
  ) {
    checks.push({
      kind: "expected",
      passed: false,
      detail: "fixture declares no expectation files",
    });
  }

  const allPassed = checks.length > 0 && checks.every((c) => c.passed);
  return {
    name: fix.name,
    checks,
    status: allPassed ? "pass" : "fail",
    capabilities,
  };
}
