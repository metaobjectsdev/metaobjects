// Cross-port business-rules conformance corpus — fixtures/rules-check-conformance/ (ADR-0066).
//
// The rules gate is part of `meta verify` in every port; this corpus holds the other four to
// this one: the same inputs, the same diagnostics down to the message text, the same summary.
// Every case is LOADED strict first, then checked. `expected.json` is written from this
// implementation by `scripts/write-requirement-corpus-expected.ts rules` and reviewed by hand.
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, rulesSettingsOf } from "@metaobjectsdev/metadata";
import { ConfigSchema } from "@metaobjectsdev/sdk";
import { checkRules, type RulesSummary } from "../src/lib/rules-check.js";

const CORPUS_DIR = join(import.meta.dir, "../../../../../fixtures/rules-check-conformance");

interface Finding { severity: string; code: string; path?: string; message: string }
interface Expected { diagnostics: Finding[]; summary: RulesSummary | null }

type Row = readonly [severity: string, code: string, path: string, message: string];
const row = (d: Finding): Row => [d.severity, d.code, d.path ?? "", d.message];
const order = (a: Row, b: Row): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
};
const multiset = (ds: readonly Finding[]): Row[] => ds.map(row).sort(order);

/** `options.json` is the `rules` and `verify` config blocks, through the real config schema:
 *  a key it does not know, or a value outside its set, fails the case instead of being ignored. */
function readSettings(caseDir: string) {
  const file = join(caseDir, "options.json");
  const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return rulesSettingsOf(ConfigSchema.pick({ rules: true, verify: true }).strict().parse(raw));
}

function documentedCases(): string[] {
  const readme = readFileSync(join(CORPUS_DIR, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((s) => s.startsWith("Cases\n"));
  if (section === undefined) throw new Error("README.md has no '## Cases' section");
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

const cases = readdirSync(CORPUS_DIR).filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory()).sort();

describe("rules-check conformance corpus", () => {
  test("every case on disk is documented in the README, and nothing else is", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(documentedCases().sort()).toEqual(cases);
  });

  for (const name of cases) {
    test(name, async () => {
      const caseDir = join(CORPUS_DIR, name);
      const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as Expected;
      const result = await MetaDataLoader.fromDirectory(join(caseDir, "input"), { strict: true });
      expect(result.errors.map(String)).toEqual([]);
      const { diagnostics, summary } = checkRules(result.root, readSettings(caseDir));
      expect(multiset(diagnostics)).toEqual(multiset(expected.diagnostics));
      expect(summary ?? null).toStrictEqual(expected.summary);
    });
  }
});
