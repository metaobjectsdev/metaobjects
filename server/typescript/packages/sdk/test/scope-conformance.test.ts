// server/typescript/packages/sdk/test/scope-conformance.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileScope, matchesScope, type Scope } from "../src/scope.js";

interface Case {
  name: string;
  scope: Scope;
  expect: Array<{ fqn: string; matches: boolean }>;
}

const CORPUS = join(import.meta.dir, "../../../../../fixtures/scope-conformance/cases.json");
const cases = (JSON.parse(readFileSync(CORPUS, "utf8")) as { cases: Case[] }).cases;

describe("scope-conformance corpus", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const c of cases) {
    test(c.name, () => {
      const compiled = compileScope(c.scope);
      for (const e of c.expect) {
        expect({ fqn: e.fqn, matches: matchesScope(e.fqn, compiled) })
          .toEqual({ fqn: e.fqn, matches: e.matches });
      }
    });
  }
});
