// Cross-port requirement-check conformance corpus — fixtures/requirement-check-conformance/.
//
// The requirement gate is core (`meta verify` is a drift gate), and ADR-0057 puts it in
// every port. This corpus is what holds the other four to this one: the same inputs, the
// same diagnostics down to the message text, the same summary counts.
//
// Every case is LOADED strict first, so "this model loads today" is proven by the fixture
// rather than asserted in prose, and only then checked. `expected.json` is written from
// this implementation by `scripts/write-requirement-corpus-expected.ts` and reviewed by
// hand; this runner is what stops it drifting afterwards.
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import {
  checkRequirements,
  scanRequirements,
  summariseRequirements,
  type RequirementSummary,
} from "../src/lib/requirement-check.js";

const CORPUS_DIR = join(import.meta.dir, "../../../../../fixtures/requirement-check-conformance");

/** `path` is absent on a diagnostic whose subject is not a requirement (object coverage). */
interface Finding { severity: string; code: string; path?: string; message: string }
interface Expected { diagnostics: Finding[]; summary: RequirementSummary | null }

/** The whole of `options.json`. A key outside this list is refused rather than ignored: a
 *  misspelt `requireImplementers` would otherwise run the case without the strict switch
 *  and pin the wrong severity in every port. */
const OPTION_KEYS = ["libraries", "requireImplementers"] as const;
interface Options { libraries?: string[]; requireImplementers?: boolean }

type Row = readonly [severity: string, code: string, path: string, message: string];

const row = (d: Finding): Row => [d.severity, d.code, d.path ?? "", d.message];
const order = (a: Row, b: Row): number => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
};
/** The comparison the corpus README names: a sorted multiset of (severity, code, path, message). */
const multiset = (ds: readonly Finding[]): Row[] => ds.map(row).sort(order);

function readOptions(caseDir: string): Options {
  const file = join(caseDir, "options.json");
  if (!existsSync(file)) return {};
  const options = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(options).filter((k) => !(OPTION_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`${file}: unknown option(s) ${unknown.join(", ")}`);
  return options as Options;
}

/** The case names the README's "Cases" table documents, in table order. */
function documentedCases(): string[] {
  const readme = readFileSync(join(CORPUS_DIR, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((s) => s.startsWith("Cases\n"));
  if (section === undefined) throw new Error("README.md has no '## Cases' section");
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

const cases = readdirSync(CORPUS_DIR).filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory()).sort();

describe("requirement-check conformance corpus", () => {
  test("every case on disk is documented in the README, and nothing else is", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(documentedCases().sort()).toEqual(cases);
  });

  for (const name of cases) {
    test(name, async () => {
      const caseDir = join(CORPUS_DIR, name);
      const expectedFile = join(caseDir, "expected.json");
      if (!existsSync(expectedFile)) {
        throw new Error(
          `${name}: no expected.json. Write it with ` +
            `'bun scripts/write-requirement-corpus-expected.ts check', then review it by hand.`,
        );
      }
      const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as Expected;
      const options = readOptions(caseDir);

      const result = await MetaDataLoader.fromDirectory(join(caseDir, "input"), {
        strict: true,
        ...(options.libraries === undefined ? {} : { libraries: options.libraries }),
      });
      expect(result.errors.map(String)).toEqual([]);

      const scan = scanRequirements(result.root, {
        requireImplementers: options.requireImplementers ?? false,
      });
      expect(multiset(checkRequirements(result.root, scan))).toEqual(multiset(expected.diagnostics));
      expect(summariseRequirements(result.root, scan) ?? null).toStrictEqual(expected.summary);
    });
  }
});
