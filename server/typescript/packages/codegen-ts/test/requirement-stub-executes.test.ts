// FR-038 §12 — the gate that actually matters.
//
// A text assertion cannot tell a failing stub from a passing one. This repo has
// been bitten precisely here: three defects once hid behind text asserts, and a
// golden file goes quiet the moment it is regenerated to match a bad fix. So these
// tests WRITE the generated stub to disk and RUN it, asserting on the exit code.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRequirementTest } from "../src/templates/requirement-test.js";
import type { RequirementTestArgs } from "../src/templates/requirement-test.js";

function args(status: string): RequirementTestArgs {
  return {
    view: {
      subType: "functional",
      level: 4,
      status,
      path: "req.probe",
      implementedByTypes: [],
    },
    concern: "object.entity",
    statement: "A council has a human-readable slug.",
    counterexample: "a council with no slug",
    targets: [],
  };
}

function runStub(src: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "req-stub-"));
  const file = join(dir, "stub.test.ts");
  writeFileSync(file, src);
  const r = Bun.spawnSync(["bun", "test", file], { cwd: dir });
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

describe("generated stubs actually behave when run", () => {
  test("a LIVE stub FAILS", () => {
    // The whole inversion rests on this. An empty-but-green stub would assert the
    // opposite of the claim it was generated from.
    expect(runStub(renderRequirementTest(args("live"))).code).not.toBe(0);
  });

  test("a PARTIAL stub FAILS too — a known gap still pins the part that works", () => {
    expect(runStub(renderRequirementTest(args("partial"))).code).not.toBe(0);
  });

  test("a PLANNED stub is SKIPPED, not passed and not failed", () => {
    const { code, out } = runStub(renderRequirementTest(args("planned")));
    expect(out).toContain("skip");
    expect(code).toBe(0);
  });

  test("the failure message names the requirement and its violation", () => {
    const { out } = runStub(renderRequirementTest(args("live")));
    expect(out).toContain("req.probe");
    expect(out).toContain("a council with no slug");
  });

  test("PROOF THE GATE CAN FAIL: filling the body in makes it pass", () => {
    // Without this the suite could be asserting "every stub always fails", which a
    // permanently-red wall would also satisfy. Replacing the stub body with a real
    // assertion must flip it green — that is what makes it a test rather than a wall.
    const filled = renderRequirementTest(args("live")).replace(
      /expect\.unreachable\([\s\S]*?\);/,
      "expect(1).toBe(1);",
    );
    const { code, out } = runStub(filled);
    expect(out).not.toContain("unimplemented requirement stub");
    expect(code).toBe(0);
  });
});
