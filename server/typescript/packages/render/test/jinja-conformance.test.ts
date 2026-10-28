import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  render,
  verify,
  InMemoryProvider,
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  ERR_TEMPLATE_NOT_STATIC,
  ERR_TEMPLATE_SYNTAX,
  type PayloadField,
  type RenderFormat,
  type VerifyError,
  type VerifyOptions,
} from "../src/index.js";

// Jinja conformance corpora (ADR-0061) — the TypeScript half of the Jinja arm, shared
// with the Python port and run by no other port (Java, Kotlin and C# run Mustache only).
//
//   fixtures/jinja-render-conformance/<case>/  meta.json { format, note }, template.jinja,
//     partials/<name>.jinja (as `partials/<name>`), payload.json, and expected.txt
//     (byte-identical) or expected-error.txt (the exact error message).
//   fixtures/jinja-verify-conformance/<case>/  payload.json (the FIELD TREE), template.jinja,
//     partials/, options.json { requiredSlots?, requiredTags?, provider? }, and
//     expected-drift.json (a sorted multiset). An ERR_TEMPLATE_SYNTAX path is the engine's
//     own parser message, so it is compared as "".
//
// Mirrors server/python/tests/render/test_jinja_conformance.py.
const FIXTURES = join(import.meta.dir, "../../../../../fixtures");
const RENDER = join(FIXTURES, "jinja-render-conformance");
const VERIFY = join(FIXTURES, "jinja-verify-conformance");

const VERIFY_CODES = new Set<string>([
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  ERR_TEMPLATE_NOT_STATIC,
  ERR_TEMPLATE_SYNTAX,
]);

const casesOf = (root: string): string[] =>
  readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort();

function providerOf(dir: string): InMemoryProvider {
  const map: Record<string, string> = {};
  const pdir = join(dir, "partials");
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir)) {
      if (f.endsWith(".jinja")) map[`partials/${f.replace(/\.jinja$/, "")}`] = readFileSync(join(pdir, f), "utf8");
    }
  }
  return new InMemoryProvider(map, { engine: "jinja" });
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("jinja-render-conformance corpus", () => {
  const names = casesOf(RENDER);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    test(name, () => {
      const dir = join(RENDER, name);
      const meta = JSON.parse(read(dir, "meta.json")) as { format?: RenderFormat };
      const run = (): string =>
        render({
          template: read(dir, "template.jinja"),
          payload: JSON.parse(read(dir, "payload.json")),
          provider: providerOf(dir),
          format: meta.format ?? "text",
          engine: "jinja",
        });
      if (existsSync(join(dir, "expected-error.txt"))) {
        expect(run).toThrow(read(dir, "expected-error.txt").replace(/\n$/, ""));
        return;
      }
      const actual = run();
      expect(actual).toBe(read(dir, "expected.txt"));
      expect(run()).toBe(actual); // determinism
    });
  }
});

const normalized = (xs: readonly VerifyError[]): VerifyError[] =>
  xs
    .map((e) => ({ code: e.code, path: e.code === ERR_TEMPLATE_SYNTAX ? "" : e.path }))
    .sort((a, b) => (a.code !== b.code ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));

describe("jinja-verify-conformance corpus", () => {
  const names = casesOf(VERIFY);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    test(name, () => {
      const dir = join(VERIFY, name);
      const fields = JSON.parse(read(dir, "payload.json")) as PayloadField[];
      const opts = existsSync(join(dir, "options.json"))
        ? (JSON.parse(read(dir, "options.json")) as {
            requiredSlots?: string[];
            requiredTags?: string[];
            provider?: "with" | "without";
          })
        : {};
      const expected = JSON.parse(read(dir, "expected-drift.json")) as VerifyError[];
      for (const e of expected) expect(VERIFY_CODES.has(e.code)).toBe(true);
      const mode = opts.provider ?? (existsSync(join(dir, "partials")) ? "with" : "without");
      const verifyOpts: VerifyOptions = {
        engine: "jinja",
        ...(mode === "with" ? { provider: providerOf(dir) } : {}),
        ...(opts.requiredSlots ? { requiredSlots: opts.requiredSlots } : {}),
        ...(opts.requiredTags ? { requiredTags: opts.requiredTags } : {}),
      };
      const actual = verify(read(dir, "template.jinja"), fields, verifyOpts);
      expect(normalized(actual)).toEqual(normalized(expected));
    });
  }
});
