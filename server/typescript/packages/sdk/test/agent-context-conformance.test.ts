// test/agent-context-conformance.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assemble } from "../src/agent-context/assemble.js";
import { makeStack } from "../src/agent-context/resolve.js";
import type { ServerLang, ClientFramework } from "../src/agent-context/types.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../agent-context");
const CORPUS = join(import.meta.dir, "../../../../../fixtures/agent-context-conformance");

interface StackSpec { servers: ServerLang[]; clients: ClientFramework[]; }

function walkExpected(dir: string, base = dir, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkExpected(p, base, acc);
    else acc[relative(base, p)] = readFileSync(p, "utf8");
  }
  return acc;
}

describe("agent-context-conformance corpus", () => {
  const cases = existsSync(CORPUS)
    ? readdirSync(CORPUS).filter((n) => existsSync(join(CORPUS, n, "stack.json")))
    : [];
  expect(cases.length).toBeGreaterThan(0);

  for (const name of cases) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const spec = JSON.parse(readFileSync(join(dir, "stack.json"), "utf8")) as StackSpec;
      const stack = makeStack(spec.servers, spec.clients);
      const files = assemble({ contentRoot: CONTENT_ROOT, stack });
      const actual: Record<string, string> = {};
      for (const f of files) actual[f.path] = f.contents;
      const expected = walkExpected(join(dir, "expected"));
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const path of Object.keys(expected)) expect(actual[path]).toBe(expected[path]);
      expect(assemble({ contentRoot: CONTENT_ROOT, stack })).toEqual(files);
    });
  }
});
