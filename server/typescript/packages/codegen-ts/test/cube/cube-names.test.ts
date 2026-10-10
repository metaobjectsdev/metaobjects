// FR-044 Plan 4 — Table G's name rules, as cube-names.ts enforces them. A name Cube refuses is
// an error naming the node, never a rename: the name is the report field's.
import { describe, test, expect } from "bun:test";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import { assertCubeName, MemberNamespace, PYTHON_KEYWORDS } from "../../src/cube/cube-names.js";

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CubeModelError) return e.code;
    throw e;
  }
  return undefined;
}

describe("assertCubeName", () => {
  test.each(["Program", "createdAt", "longShare", "Match_homeRef", "a1", "x"])("accepts %s", (name) => {
    expect(codeOf(() => assertCubeName(name, `dimension '${name}'`))).toBeUndefined();
  });

  test.each(["_t", "1st", "", "has-dash", "has space", "dotted.name", "brace{"])("refuses %p", (name) => {
    expect(codeOf(() => assertCubeName(name, "dimension 'x'"))).toBe("ERR_CUBE_INVALID_NAME");
  });

  test("every Python keyword Table G lists is refused", () => {
    const listed = [
      "from", "class", "in", "is", "not", "and", "or", "if", "else", "for", "while", "with", "as", "def",
      "return", "yield", "import", "pass", "global", "nonlocal", "lambda", "del", "assert", "break",
      "continue", "try", "except", "finally", "raise", "async", "await", "True", "False", "None", "elif",
    ];
    expect([...PYTHON_KEYWORDS].sort()).toEqual([...listed].sort());
    for (const kw of listed) expect(codeOf(() => assertCubeName(kw, `measure '${kw}'`))).toBe("ERR_CUBE_INVALID_NAME");
  });

  test("the message names the node, says why, and says what to do", () => {
    try {
      assertCubeName("class", "measure 'acme::shop::Program.class'");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CubeModelError);
      const msg = (e as Error).message;
      expect(msg).toStartWith("ERR_CUBE_INVALID_NAME: measure 'acme::shop::Program.class'");
      expect(msg).toContain("Python keyword");
      expect(msg).toContain("Rename");
    }
  });
});

describe("MemberNamespace", () => {
  test("dimensions, measures and segments share one namespace, and a collision names both", () => {
    const ns = new MemberNamespace("Program");
    ns.add("status", "dimension 'acme::shop::Program.status'");
    try {
      ns.add("status", "segment 'acme::shop::Program.status'");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CubeModelError);
      expect((e as CubeModelError).code).toBe("ERR_CUBE_MEMBER_COLLISION");
      const msg = (e as Error).message;
      expect(msg).toContain("cube 'Program'");
      expect(msg).toContain("dimension 'acme::shop::Program.status'");
      expect(msg).toContain("segment 'acme::shop::Program.status'");
    }
  });

  test("each added name is checked for validity", () => {
    const ns = new MemberNamespace("Program");
    expect(codeOf(() => ns.add("from", "dimension 'x'"))).toBe("ERR_CUBE_INVALID_NAME");
  });
});
