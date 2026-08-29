// Author prose goes into a string literal and a JSDoc block, so it must be escaped.
//
// `statement` and `counterexample` are free text a human writes. Interpolated raw, an
// apostrophe-free but quote-bearing sentence closes the generated string literal, a
// backslash starts an escape, a newline breaks the single-line literal, and a `*/`
// ends the JSDoc comment early and drops the rest of the file into syntax soup.
//
// `meta gen` reports the stub as written either way — the failure only surfaces when
// the application's test runner tries to load it, which is exactly the kind of
// generated-code defect a text assertion cannot see. So these tests EXECUTE the stub.

import { describe, test, expect } from "bun:test";
import {
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  type RequirementStatus,
} from "@metaobjectsdev/metadata";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRequirementTest } from "../src/templates/requirement-test.js";

const view = {
  subType: "functional",
  level: 4,
  status: "live",
  path: "req.probe",
  implementedByTypes: [],
} as const;

function render(statement: string, counterexample: string): string {
  return renderRequirementTest({
    view: { ...view },
    concern: "object.entity",
    statement,
    counterexample,
    targets: [],
  });
}

/** Write the stub and run it, returning bun's exit code and combined output. */
function runStub(src: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "req-escape-"));
  try {
    const file = join(dir, "stub.test.ts");
    writeFileSync(file, src);
    const r = Bun.spawnSync(["bun", "test", file], { cwd: dir });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stub that PARSES fails with our unreachable message; one that does not parse
 *  fails with a syntax/parse error. Both are non-zero, so the exit code alone cannot
 *  tell them apart — the message is what distinguishes them. */
function parsedCleanly(out: string): boolean {
  return out.includes("unimplemented requirement stub") && !/error: (Unexpected|Expected)/i.test(out);
}

describe("author prose cannot break the generated stub", () => {
  test("a double quote in the counterexample", () => {
    const src = render("Notes are private.", 'the GM sees a player\'s "secret" notes');
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a backslash", () => {
    const src = render("Paths are normalised.", "a raw C:\\\\Users path reaches the API");
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("an embedded newline", () => {
    const src = render("Multi-line prose survives.", "a counterexample\ndescribed over two lines");
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a JSDoc terminator in the statement", () => {
    // `*/` would close the doc comment early and spill the rest into code.
    const src = render("A glob like /**/ is legal prose.", "the comment ends early");
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a backtick and a template placeholder", () => {
    const src = render("Templates render `${name}` literally.", "`${x}` is interpolated");
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("the prose still reaches the reader intact", () => {
    // Escaping must not mangle what the author wrote — the doc comment is the whole
    // point of putting the claim next to the assertion.
    const src = render('A council\'s "slug" is stable.', "a renamed slug breaks a link");
    expect(src).toContain('A council\'s "slug" is stable.');
    expect(src).toContain("a renamed slug breaks a link");
  });
});

// `statement` and `counterexample` are the OBVIOUS free-text fields, and escaping only
// those leaves the same hole open in four more places that reach the same literal and
// the same JSDoc block. `@trackedBy` is the sharpest of them: it is registered as
// free-form on purpose — `verify` never resolves it, because which sprint owns a gap
// lives in the tracker — so it is the one field whose contract invites arbitrary text.
describe("every author-supplied field is escaped, not just the two obvious ones", () => {
  function renderWith(extra: Partial<Parameters<typeof renderRequirementTest>[0]>): string {
    return renderRequirementTest({
      view: { ...view },
      concern: "object.entity",
      statement: "Notes are private.",
      counterexample: "the GM sees a player's notes",
      targets: [],
      ...extra,
    });
  }

  test("a JSDoc terminator in a @trackedBy entry", () => {
    const src = renderWith({ disposition: "deferred", trackedBy: ["ACME-1 /* see */ ACME-2"] });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a JSDoc terminator in a @disposition", () => {
    const src = renderWith({ disposition: "deferred */ leaked" });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a JSDoc terminator in a claimed reference", () => {
    const src = renderWith({ targets: [{ ref: "acme::Widget /**/ x", node: {} as never, concern: "object.entity" }] });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a double quote in the requirement path", () => {
    // `path` is interpolated into TWO double-quoted literals — the test name and the
    // unreachable message — so a quote closes both.
    const src = renderWith({ view: { ...view, path: 'req."probe"' } });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a double quote in the concern", () => {
    const src = renderWith({ concern: 'object."entity"' });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a backslash in the requirement path", () => {
    const src = renderWith({ view: { ...view, path: "req\\probe" } });
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });
});

describe("a retired requirement does not redden the suite forever", () => {
  // A status that does not claim the capability works RIGHT NOW — `planned`, not built
  // yet; `retired`, built then deliberately removed — must not emit a failing stub. A
  // permanent red build for something nobody intends to build is what makes an app
  // silence the whole generator, taking the `live` stubs with it.
  //
  // Both lists are DERIVED from the loader's enum rather than written out. They used to
  // be literals naming `abandoned` and `superseded`, and when 0.24.0 retired both and
  // 0.24.2 put `retired` in their place, this file went on asserting the behaviour of
  // two statuses the loader had begun REFUSING while saying nothing about the one that
  // replaced them — passing throughout, and pinning the defect instead of catching it.
  // The split under test is the semantic one: does this status claim the capability
  // works now, or not.
  // LITERAL, not derived. The implementation computes its skip set as
  // `REQUIREMENT_STATUSES minus REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES`; a test that
  // computes the identical expression proves only that the code agrees with itself.
  // Move `retired` into the live-nodes list by mistake and both would follow, every
  // assertion below would follow, and every retired entry would emit a permanently red
  // stub with the suite still green — the exact regression this block exists for.
  //
  // Written out, the expectations are independent. The exhaustiveness check underneath
  // is what stops them going stale, which is the failure this file had before: it named
  // `abandoned` and `superseded` for a release after the loader stopped accepting them.
  const SKIPS: readonly RequirementStatus[] = ["planned", "retired"];
  const FAILS: readonly RequirementStatus[] = ["live", "partial"];

  test("the two lists together are exactly the loader's status enum", () => {
    expect([...SKIPS, ...FAILS].sort()).toEqual([...REQUIREMENT_STATUSES].sort());
    // And the split agrees with what the enum MEANS, checked once rather than assumed
    // for every case below.
    for (const s of FAILS) expect(REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES).toContain(s);
    for (const s of SKIPS) expect(REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES).not.toContain(s);
  });

  for (const status of SKIPS) {
    test(`${status} emits a skipped test`, () => {
      const src = renderRequirementTest({
        view: { ...view, status },
        concern: "object.entity",
        statement: "s",
        counterexample: "v",
        targets: [],
      });
      expect(src).toContain("test.skip");
      expect(src).not.toContain("expect.unreachable");
    });
  }

  for (const status of FAILS) {
    test(`${status} still fails until filled — it claims the capability works`, () => {
      const src = renderRequirementTest({
        view: { ...view, status },
        concern: "object.entity",
        statement: "s",
        counterexample: "v",
        targets: [],
      });
      expect(src).toContain("expect.unreachable");
      expect(src).not.toContain("test.skip");
    });
  }
});
