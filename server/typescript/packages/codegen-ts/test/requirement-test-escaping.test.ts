// Author prose goes into a string literal and a JSDoc block, so it must be escaped.
//
// `@statement` and `@violation` are free text a human writes. Interpolated raw, an
// apostrophe-free but quote-bearing sentence closes the generated string literal, a
// backslash starts an escape, a newline breaks the single-line literal, and a `*/`
// ends the JSDoc comment early and drops the rest of the file into syntax soup.
//
// `meta gen` reports the stub as written either way — the failure only surfaces when
// the application's test runner tries to load it, which is exactly the kind of
// generated-code defect a text assertion cannot see. So these tests EXECUTE the stub.

import { describe, test, expect } from "bun:test";
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

function render(statement: string, violation: string): string {
  return renderRequirementTest({
    view: { ...view },
    concern: "object.entity",
    statement,
    violation,
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
  test("a double quote in the violation", () => {
    const src = render("Notes are private.", 'the GM sees a player\'s "secret" notes');
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("a backslash", () => {
    const src = render("Paths are normalised.", "a raw C:\\\\Users path reaches the API");
    expect(parsedCleanly(runStub(src).out)).toBe(true);
  });

  test("an embedded newline", () => {
    const src = render("Multi-line prose survives.", "a violation\ndescribed over two lines");
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

describe("a retired requirement does not redden the suite forever", () => {
  // `abandoned` / `superseded` describe a capability deliberately retired — their
  // `@implementedBy` is SUPPOSED to dangle. A failing stub for one is a permanent red
  // build for something nobody intends to build, and the app silences the whole
  // generator to escape it, taking the `live` stubs with it.
  for (const status of ["planned", "abandoned", "superseded"]) {
    test(`${status} emits a skipped test`, () => {
      const src = renderRequirementTest({
        view: { ...view, status },
        concern: "object.entity",
        statement: "s",
        violation: "v",
        targets: [],
      });
      expect(src).toContain("test.skip");
      expect(src).not.toContain("expect.unreachable");
    });
  }

  for (const status of ["live", "partial"]) {
    test(`${status} still fails until filled — it claims the capability works`, () => {
      const src = renderRequirementTest({
        view: { ...view, status },
        concern: "object.entity",
        statement: "s",
        violation: "v",
        targets: [],
      });
      expect(src).toContain("expect.unreachable");
      expect(src).not.toContain("test.skip");
    });
  }
});
