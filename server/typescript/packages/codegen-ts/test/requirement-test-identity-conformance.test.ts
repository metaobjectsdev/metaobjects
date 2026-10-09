// Cross-port requirement-test identity corpus — fixtures/requirement-test-identity-conformance/.
//
// Every port generates a test per requirement, each in its own language and test
// framework, and the generated FILES are free to differ. What may not differ is which
// tests a ledger yields, what each is called, whether it is skipped, the fingerprint of
// the claim it tests, and what a project's filter is shown. This corpus pins those, and
// this runner holds the TypeScript reference to it.
//
// Every case is LOADED strict first, so "this model loads today" is proven by the fixture
// rather than asserted in prose. `expected.json` is written from this implementation by
// `scripts/write-requirement-corpus-expected.ts identity` and reviewed by hand; this
// runner is what stops it drifting afterwards.
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MetaDataLoader,
  OBJECT_SUBTYPE_ENTITY,
  REQUIREMENT_LEVEL_MEMBER,
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  TYPE_OBJECT,
} from "@metaobjectsdev/metadata";
// The package's PUBLIC exports, not the module they are defined in: the filter seam under
// test is the one an application reaches.
import { requirementTestIdentities, witnessKeyCollisions } from "../src/index.js";
import type {
  RequirementTestGrain,
  RequirementTestIdentity,
  RequirementView,
} from "../src/index.js";

const CORPUS_DIR = join(
  import.meta.dir,
  "../../../../../fixtures/requirement-test-identity-conformance",
);

interface Expected {
  tests: RequirementTestIdentity[];
  collisions: [string, string][];
}

/** The whole of `options.json`. A key outside this list is refused rather than ignored: a
 *  misspelt `filter` would otherwise run the case under the default filter and pin the
 *  wrong set of tests in every port. */
const OPTION_KEYS = ["grain", "filter"] as const;
interface Options { grain?: RequirementTestGrain; filter?: string }

type Predicate = (r: RequirementView) => boolean;

/**
 * The corpus's closed list of filters. A predicate cannot be written in a file five
 * languages read, so a case NAMES one and every port's runner holds this table in its own
 * language, handing the predicate to its public filter seam. Between them the eight rows
 * read every field of the requirement view, and `unlevelled` reads a field that is not
 * there.
 *
 * A Map, not an object literal: looking `constructor` up in a literal finds
 * `Object.prototype`'s, so a misnamed filter would be run as a predicate that keeps
 * everything instead of being refused.
 */
const FILTERS: ReadonlyMap<string, Predicate> = new Map<string, Predicate>([
  ["all", () => true],
  ["architectural", (r) => r.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL],
  ["live", (r) => r.status === REQUIREMENT_STATUS_LIVE],
  ["level-5", (r) => r.level === REQUIREMENT_LEVEL_MEMBER],
  ["unlevelled", (r) => r.level === undefined],
  ["package-acme-shop", (r) => r.package === "acme::shop"],
  ["path-under-Shop", (r) => r.path === "Shop" || r.path.startsWith("Shop.")],
  ["claims-entity", (r) => r.implementedByTypes.includes(`${TYPE_OBJECT}.${OBJECT_SUBTYPE_ENTITY}`)],
]);

function readOptions(caseDir: string): Options {
  const file = join(caseDir, "options.json");
  if (!existsSync(file)) return {};
  const options = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(options).filter((k) => !(OPTION_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`${file}: unknown option(s) ${unknown.join(", ")}`);
  return options as Options;
}

function filterNamed(name: string): Predicate {
  const filter = FILTERS.get(name);
  if (filter === undefined) {
    throw new Error(`unknown filter '${name}'. The corpus names: ${[...FILTERS.keys()].join(", ")}`);
  }
  return filter;
}

// Code units, as the reference orders ids: a locale collation differs between machines.
const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The comparison the corpus README names: both sides sorted by `id`. */
const byId = (tests: readonly RequirementTestIdentity[]): RequirementTestIdentity[] =>
  [...tests].sort((a, b) => codeUnits(a.id, b.id));
/** …and each collision pair sorted, then the list. */
const sortedPairs = (pairs: readonly (readonly [string, string])[]): string[][] =>
  pairs
    .map((pair) => [...pair].sort(codeUnits))
    .sort((a, b) => codeUnits(a[0]!, b[0]!) || codeUnits(a[1]!, b[1]!));

/** The case names the README's "Cases" table documents, in table order. */
function documentedCases(): string[] {
  const readme = readFileSync(join(CORPUS_DIR, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((s) => s.startsWith("Cases\n"));
  if (section === undefined) throw new Error("README.md has no '## Cases' section");
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

const cases = readdirSync(CORPUS_DIR).filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory()).sort();

describe("requirement-test identity conformance corpus", () => {
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
            `'bun scripts/write-requirement-corpus-expected.ts identity', then review it by hand.`,
        );
      }
      const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as Expected;
      const options = readOptions(caseDir);

      const result = await MetaDataLoader.fromDirectory(join(caseDir, "input"), { strict: true });
      expect(result.errors.map(String)).toEqual([]);

      // Each option is passed only when the case sets it, so a case without one runs
      // the port's own default — which is itself part of what the corpus pins.
      const tests = requirementTestIdentities(result.root, {
        ...(options.grain === undefined ? {} : { grain: options.grain }),
        ...(options.filter === undefined ? {} : { filter: filterNamed(options.filter) }),
      });
      expect(byId(tests)).toStrictEqual(byId(expected.tests));
      expect(sortedPairs(witnessKeyCollisions(tests))).toStrictEqual(sortedPairs(expected.collisions));
    });
  }
});
