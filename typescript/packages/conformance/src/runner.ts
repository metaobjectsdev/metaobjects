// The runner engine — runs one fixture's checks through a ConformanceAdapter.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import type { ConformanceAdapter } from "./adapter.js";
import { UnknownCapabilityError } from "./adapter.js";
import { parseOperationScript } from "./operation-script.js";
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
    const expected = (await readJson(join(fix.dir, "expected-errors.json"))) as
      { code: string }[];
    const want = expected.map((e) => e.code).sort();
    const got = [...outcome.errorCodes].sort();
    const passed = want.length === got.length && want.every((c, i) => c === got[i]);
    checks.push({
      kind: "expected-errors",
      passed,
      detail: `expected [${want}], got [${got}]`,
    });
  }

  if (fix.hasExpected && outcome.tree !== undefined) {
    const want = (await readFile(join(fix.dir, "expected.json"), "utf8")).trim();
    const got = adapter.canonicalSerialize(outcome.tree).trim();
    const passed = want === got;
    checks.push({
      kind: "expected",
      passed,
      ...(passed ? {} : { detail: "canonical serialization mismatch" }),
    });
  }

  if (fix.hasExpectedEffective && outcome.tree !== undefined) {
    const want = (await readFile(join(fix.dir, "expected-effective.json"), "utf8")).trim();
    const got = adapter.canonicalSerializeEffective(outcome.tree).trim();
    const passed = want === got;
    checks.push({
      kind: "expected-effective",
      passed,
      ...(passed ? {} : { detail: "effective serialization mismatch" }),
    });
  }

  if (fix.hasScript && outcome.tree !== undefined) {
    const script = parseOperationScript(await readJson(join(fix.dir, "script.json")));
    script.operations.forEach((op, i) => {
      if (!capabilities.includes(op.invoke)) capabilities.push(op.invoke);
      const node = adapter.navigate(outcome.tree!, op.navigate);
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

  const allPassed = checks.length > 0 && checks.every((c) => c.passed);
  return {
    name: fix.name,
    checks,
    status: allPassed ? "pass" : "fail",
    capabilities,
  };
}
