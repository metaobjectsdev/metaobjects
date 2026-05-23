import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  verify,
  InMemoryProvider,
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "../src/index.js";

// Verify-conformance corpus: the cross-language template-drift oracle (FR-004
// Plan #3 C). Each fixture dir under fixtures/verify-conformance/ holds
//   payload.json         the payload FIELD-TREE — PayloadField[], the declared
//                        shape (NOT render data, unlike render-conformance)
//   template.mustache    the template text whose {{vars}} are drift-checked
//   partials/*.mustache  optional partial bodies, referenced as `partials/<name>`
//   options.json         optional { requiredSlots?, requiredTags?: string[]; provider?: "with" | "without" }
//   expected-drift.json  array of { code, path } findings (compared as a sorted multiset)
// The same (payload-tree + template + options) MUST yield expected-drift.json in
// every language port that implements `verify`. Mirrors render-conformance.test.ts.
const CORPUS = join(import.meta.dir, "../../../../../fixtures/verify-conformance");

// The closed set of codes a verify fixture may legitimately expect — the stable
// verify ErrorCodes (documented in fixtures/conformance/ERROR-CODES.json).
// A fixture expecting anything else is a typo, caught per-fixture below.
const VERIFY_CODES = new Set<string>([
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
]);

interface FixtureOptions {
  requiredSlots?: string[];
  requiredTags?: string[];
  provider?: "with" | "without";
}

function readOptions(dir: string): FixtureOptions {
  const path = join(dir, "options.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FixtureOptions) : {};
}

function providerFromPartials(dir: string): InMemoryProvider {
  const map: Record<string, string> = {};
  const pdir = join(dir, "partials");
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir)) {
      if (f.endsWith(".mustache")) {
        map[`partials/${f.replace(/\.mustache$/, "")}`] = readFileSync(join(pdir, f), "utf8");
      }
    }
  }
  return new InMemoryProvider(map);
}

// Total order over (code, path): the corpus compares drift as a sorted multiset
// so a fixture is independent of the order a port's Mustache walk emits errors.
const bySortKey = (a: VerifyError, b: VerifyError) =>
  a.code !== b.code ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path);

describe("verify-conformance corpus", () => {
  const names = existsSync(CORPUS)
    ? readdirSync(CORPUS).filter((n) => statSync(join(CORPUS, n)).isDirectory())
    : [];
  expect(names.length).toBeGreaterThan(0);

  for (const name of names) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const fields = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8")) as PayloadField[];
      const template = readFileSync(join(dir, "template.mustache"), "utf8");
      const opts = readOptions(dir);
      const expected = JSON.parse(
        readFileSync(join(dir, "expected-drift.json"), "utf8"),
      ) as VerifyError[];

      // Lint: every expected code is a known verify code (typo guard).
      for (const e of expected) expect(VERIFY_CODES.has(e.code)).toBe(true);

      // Provider: "with" → build from partials/ (empty map if none); "without" →
      // none. Default: "with" iff a partials/ dir exists. An empty provider
      // (provider:"with", no partials/) is how the unresolved-partial case is set.
      const mode = opts.provider ?? (existsSync(join(dir, "partials")) ? "with" : "without");
      // Omit absent keys rather than set them to `undefined` (exactOptionalPropertyTypes).
      const verifyOpts: VerifyOptions = {
        ...(mode === "with" ? { provider: providerFromPartials(dir) } : {}),
        ...(opts.requiredSlots ? { requiredSlots: opts.requiredSlots } : {}),
        ...(opts.requiredTags ? { requiredTags: opts.requiredTags } : {}),
      };

      const actual = verify(template, fields, verifyOpts);
      expect([...actual].sort(bySortKey)).toEqual([...expected].sort(bySortKey));
      // determinism: identical across runs.
      expect(verify(template, fields, verifyOpts)).toEqual(actual);
    });
  }
});
