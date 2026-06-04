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
    let envelope: ReturnType<typeof parseExpectedErrors> | undefined;
    try {
      envelope = parseExpectedErrors(await readJson(join(fix.dir, "expected-errors.json")));
    } catch (err) {
      checks.push({
        kind: "expected-errors",
        passed: false,
        detail: `expected-errors.json parse error: ${(err as Error).message}`,
      });
    }
    if (envelope !== undefined) {
      // Always run the order-independent code-set check (legacy semantics).
      const want = envelope.errors.map((e) => e.code).slice().sort();
      const got = [...outcome.errorCodes].sort();
      const codesPassed = want.length === got.length && want.every((c, i) => c === got[i]);
      checks.push({
        kind: "expected-errors",
        passed: codesPassed,
        ...(codesPassed ? {} : { detail: `expected codes [${want}], got [${got}]` }),
      });

      // FR5a / ADR-0009 — when the fixture is in the post-migration envelope
      // shape AND the adapter exposes envelopes, assert source.format /
      // source.files / source.jsonPath per-error. Order MUST match because
      // the cross-port contract is "errors[i] aligns with expected[i]".
      if (!envelope.legacy && outcome.errors !== undefined) {
        const expected = envelope.errors;
        const got = outcome.errors;
        if (expected.length !== got.length) {
          checks.push({
            kind: "expected-errors",
            passed: false,
            detail: `envelope length mismatch: expected ${expected.length}, got ${got.length}`,
          });
        } else {
          for (let i = 0; i < expected.length; i++) {
            const w = expected[i]!;
            const g = got[i]!;
            if (w.code !== g.code) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].code: expected '${w.code}', got '${g.code}'`,
              });
              continue;
            }
            if (w.source === undefined) continue;
            if (w.source.format !== g.source.format) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].source.format: expected '${w.source.format}', got '${g.source.format}'`,
              });
            }
            const wf = [...w.source.files];
            const gf = [...g.source.files];
            if (wf.length !== gf.length || !wf.every((f, j) => f === gf[j])) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].source.files: expected [${wf.join(",")}], got [${gf.join(",")}]`,
              });
            }
            if (w.source.jsonPath !== undefined && w.source.jsonPath !== g.source.jsonPath) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].source.jsonPath: expected '${w.source.jsonPath}', got '${g.source.jsonPath}'`,
              });
            }
            // FR5d — referrer + target are part of the cross-port contract for
            // `format=resolved` envelopes. Assert them when present on the
            // expected entry (the schema enforces both-present when format
            // is "resolved", so this also catches a port that emitted format
            // ='resolved' but failed to populate either field).
            if (w.source.referrer !== undefined && w.source.referrer !== g.source.referrer) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].source.referrer: expected '${w.source.referrer}', got '${g.source.referrer}'`,
              });
            }
            if (w.source.target !== undefined && w.source.target !== g.source.target) {
              checks.push({
                kind: "expected-errors",
                passed: false,
                detail: `envelope[${i}].source.target: expected '${w.source.target}', got '${g.source.target}'`,
              });
            }
          }
        }
      }
      // FR5c-finalize — warnings: when the fixture's envelope declares
      // warning entries with `source`, assert per-warning envelope shape
      // (same algorithm as errors above). The block lives outside the
      // `outcome.errors !== undefined` gate so a port that ships
      // `warningEnvelopes` but not `errors` (rare) still gets the
      // assertion. When the fixture declares only counts (warnings:
      // [{code}] without source) or empty `[]`, the length check still
      // runs; the per-element source assertion is skipped element-by-
      // element when expected.source is undefined.
      if (envelope !== undefined && !envelope.legacy) {
        const expectedW = envelope.warnings;
        const gotW = outcome.warningEnvelopes;
        if (expectedW.length !== outcome.warnings.length) {
          checks.push({
            kind: "expected-warnings",
            passed: false,
            detail: `warnings count: expected ${expectedW.length}, got ${outcome.warnings.length}`,
          });
        } else if (gotW !== undefined && expectedW.length === gotW.length) {
          for (let i = 0; i < expectedW.length; i++) {
            const w = expectedW[i]!;
            const g = gotW[i]!;
            if (w.code !== g.code) {
              checks.push({
                kind: "expected-warnings",
                passed: false,
                detail: `warning[${i}].code: expected '${w.code}', got '${g.code}'`,
              });
              continue;
            }
            if (w.source === undefined) continue;
            if (w.source.format !== g.source.format) {
              checks.push({
                kind: "expected-warnings",
                passed: false,
                detail: `warning[${i}].source.format: expected '${w.source.format}', got '${g.source.format}'`,
              });
            }
            const wf = [...w.source.files];
            const gf = [...g.source.files];
            if (wf.length !== gf.length || !wf.every((f, j) => f === gf[j])) {
              checks.push({
                kind: "expected-warnings",
                passed: false,
                detail: `warning[${i}].source.files: expected [${wf.join(",")}], got [${gf.join(",")}]`,
              });
            }
            if (w.source.jsonPath !== undefined && w.source.jsonPath !== g.source.jsonPath) {
              checks.push({
                kind: "expected-warnings",
                passed: false,
                detail: `warning[${i}].source.jsonPath: expected '${w.source.jsonPath}', got '${g.source.jsonPath}'`,
              });
            }
          }
        }
      }
    }
  }

  // ADR-0023 — strict hard-fail. A fixture that declares NO expected-errors.json
  // is a happy-path fixture: under strict load it MUST load with zero errors.
  // Any recorded error (e.g. ERR_UNKNOWN_ATTR from a made-up attribute) fails
  // the fixture with a message naming the unexpected error(s). Previously this
  // was silently tolerated — the runner only byte-compared the tree and never
  // asserted the error set was empty, so a made-up attr passed. (Warnings stay
  // separate; this is about ERRORS only.) Gated on the fixture declaring at
  // least one metadata expectation file so docs-only / config-error fixtures
  // are handled by their own checks below.
  if (
    !fix.hasExpectedErrors &&
    (fix.hasExpected || fix.hasExpectedEffective || fix.hasExpectedWarnings || fix.hasScript) &&
    outcome.errorCodes.length > 0
  ) {
    checks.push({
      kind: "expected-errors",
      passed: false,
      detail: `happy-path fixture loaded with unexpected error(s): [${[...outcome.errorCodes].sort().join(", ")}] — under strict, a fixture with no expected-errors.json must load with zero errors (ADR-0023)`,
    });
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

  if (outcome.tree !== undefined) {
    if (fix.hasExpectedWarnings) {
      let want: string[] | undefined;
      try {
        const raw = await readJson(join(fix.dir, "expected-warnings.json"));
        if (!Array.isArray(raw) || !raw.every((w) => typeof w === "string")) {
          throw new Error("expected-warnings.json must be a JSON array of strings");
        }
        want = (raw as string[]).slice().sort();
      } catch (err) {
        checks.push({
          kind: "expected-warnings",
          passed: false,
          detail: `expected-warnings.json parse error: ${(err as Error).message}`,
        });
      }
      if (want !== undefined) {
        const got = [...outcome.warnings].sort();
        const passed = want.length === got.length && want.every((w, i) => w === got[i]);
        checks.push({
          kind: "expected-warnings",
          passed,
          ...(passed ? {} : { detail: `expected [${want}], got [${got}]` }),
        });
      }
    } else if (fix.hasExpected && !fix.hasExpectedErrors) {
      // Happy-path fixture with no expected-warnings.json — assert no warnings.
      // Skip when the fixture uses expected-errors.json (envelope shape); that
      // block above already asserted warning count + per-element envelope.
      const passed = outcome.warnings.length === 0;
      if (!passed) {
        checks.push({
          kind: "expected-warnings",
          passed: false,
          detail: `unexpected warnings: [${outcome.warnings.join(", ")}]`,
        });
      }
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
    !fix.hasExpectedWarnings &&
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
