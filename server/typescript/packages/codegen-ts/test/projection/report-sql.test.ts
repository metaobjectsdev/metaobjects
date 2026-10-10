// FR-044 Plan 4 Task 1 — the report SQL fragments live in one module that the view lowering
// and the Cube exporter share. The goldens in report-ddl-emit.test.ts and
// extract-report-spec.test.ts pin the behaviour; this pins the one reuse the move is for.
import { describe, test, expect } from "bun:test";
import { cond, ref } from "../../src/projection/report-sql.js";

describe("ref", () => {
  test("quotes the column and leaves the {CUBE} alias as written", () => {
    expect(ref("{CUBE}.status", "postgres")).toBe('{CUBE}."status"');
  });

  test("leaves the alias of a joined cube as written", () => {
    expect(ref("{Program}.title", "postgres")).toBe('{Program}."title"');
  });

  test("a generated join alias stays unquoted too", () => {
    expect(ref("p.title", "mysql")).toBe("p.`title`");
  });
});

describe("cond with a renderer", () => {
  const clause = {
    kind: "and" as const,
    clauses: [
      { kind: "cmp" as const, ref: "{CUBE}.status", op: "eq", value: "a{b}" },
      { kind: "cmp" as const, ref: "{CUBE}.n", op: "in", value: [1, 2] },
    ],
  };

  test("the default renders identifiers and literals as the view lowering does", () => {
    expect(cond(clause, "postgres")).toBe(`({CUBE}."status" = 'a{b}' AND {CUBE}."n" IN (1, 2))`);
  });

  test("a renderer writes every identifier and literal cond emits", () => {
    const renderer = {
      identifier: (ident: string) => `<${ident}>`,
      literal: (v: unknown) => `[${String(v)}]`,
    };
    expect(cond(clause, "postgres", renderer)).toBe("({CUBE}.<status> = [a{b}] AND {CUBE}.<n> IN ([1], [2]))");
    expect(ref("{CUBE}.status", "postgres", renderer)).toBe("{CUBE}.<status>");
  });
});
