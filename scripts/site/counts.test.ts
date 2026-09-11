import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveCounts, NOT_A_CORPUS } from "./counts.js";

const REPO = resolve(import.meta.dir, "../..");
const counts = deriveCounts(REPO);
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const dirsIn = (rel: string) =>
  readdirSync(resolve(REPO, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe("deriveCounts", () => {
  // Recomputed here by a different route than the module uses, so a bug in the
  // module cannot also define what "correct" means.
  test("fixtures is every scenario directory in the metamodel corpus", () => {
    expect(counts.fixtures).toBe(dirsIn("fixtures/conformance").length);
    expect(counts.fixtures).toBeGreaterThan(0);
  });

  test("corpora is every fixtures/ directory that is not excluded", () => {
    const all = dirsIn("fixtures");
    expect(counts.corpora).toBe(all.length - Object.keys(NOT_A_CORPUS).length);
  });

  // A stale exclusion is invisible: the directory is gone, the count silently drops
  // by one, and nothing says so. Every exclusion must name a directory that exists.
  test("every exclusion names a real directory", () => {
    const all = new Set(dirsIn("fixtures"));
    for (const name of Object.keys(NOT_A_CORPUS)) expect(all.has(name)).toBe(true);
  });

  // The reason is the point of the list — an entry without one is a slip.
  test("every exclusion carries a written reason", () => {
    for (const [name, why] of Object.entries(NOT_A_CORPUS)) {
      expect(why.length, `${name} needs a reason`).toBeGreaterThan(40);
    }
  });

  test("baseTypes is the distinct top-level type set of the registry manifest", () => {
    const manifest = JSON.parse(read("fixtures/registry-conformance/expected-registry.json"));
    const distinct = new Set<string>(manifest.types.map((t: { type: string }) => t.type));
    expect(counts.baseTypes).toBe(distinct.size);
    expect(counts.baseTypes).toBeGreaterThan(0);
  });
});

// ── the numbers typed into prose must equal the derived ones ──────────────────
// docs/CONFORMANCE.md calls itself "the single place per-corpus counts are maintained"
// and still contradicted itself: the table said 313 metamodel fixtures while the
// arithmetic 200 lines below said 255. Prose cannot be trusted to hold a number that
// something else can count.
describe("typed counts agree with the derived ones", () => {
  const conformance = read("docs/CONFORMANCE.md");
  const agents = read("AGENTS.md");

  // Both directions. A corpus missing from the table is undocumented coverage; a row
  // for a corpus that no longer exists is a claim about nothing.
  test("the CONFORMANCE.md table names exactly the corpora that exist", () => {
    const tabled = [...conformance.matchAll(/^\| \[`fixtures\/([a-z-]+)\/`\]/gm)]
      .map((m) => m[1]!)
      .sort();
    const expected = dirsIn("fixtures")
      .filter((d) => !(d in NOT_A_CORPUS))
      .sort();
    expect(tabled).toEqual(expected);
  });

  test("CONFORMANCE.md's corpora count matches", () => {
    const m = /\*\*(\d+) shared conformance corpora\*\*/.exec(conformance);
    expect(m, "CONFORMANCE.md no longer states '**N shared conformance corpora**'").not.toBeNull();
    expect(Number(m![1])).toBe(counts.corpora);
  });

  test("CONFORMANCE.md's metamodel row matches", () => {
    const m = /^\| \[`fixtures\/conformance\/`\][^|]*\| (\d+) \|/m.exec(conformance);
    expect(m, "the metamodel row no longer carries a bare fixture count").not.toBeNull();
    expect(Number(m![1])).toBe(counts.fixtures);
  });

  // The arithmetic line restates per-corpus counts the table above it already gives,
  // so every number in it is a second copy that can rot independently — which is how
  // "metamodel 255" survived under a table saying 313. Check the WHOLE line against the
  // table, not just the metamodel term: the defect is the duplication, not the instance.
  test("CONFORMANCE.md's orphaned-fixtures arithmetic matches the table above it", () => {
    const line = /The fixtures in the [a-z]+ corpora mapped above \(([^)]+)\)/.exec(conformance);
    expect(line, "the orphaned-fixtures arithmetic line has been reworded").not.toBeNull();

    // Table row -> its leading bare fixture count, for the rows that state one.
    const rows = new Map<string, number>();
    for (const m of conformance.matchAll(/^\| \[`fixtures\/([a-z-]+)\/`\][^|]*\| (\d+)[^|]*\|/gm)) {
      rows.set(m[1]!, Number(m[2]));
    }
    // The arithmetic uses short names; the table uses directory names.
    const dirOf: Record<string, string> = {
      metamodel: "conformance", yaml: "yaml-conformance", verify: "verify-conformance",
      render: "render-conformance", persistence: "persistence-conformance",
      "api-contract": "api-contract-conformance",
      "source-resolution": "source-resolution-conformance", scope: "scope-conformance",
    };

    const terms = [...line![1]!.matchAll(/([a-z-]+) (\d+)/g)];
    expect(terms.length, "no 'name N' terms found in the arithmetic line").toBeGreaterThan(0);
    for (const [, name, n] of terms) {
      const dir = dirOf[name!];
      expect(dir, `arithmetic names '${name}', which maps to no table row`).toBeDefined();
      const tabled = rows.get(dir!);
      expect(tabled, `table has no bare fixture count for ${dir}`).toBeDefined();
      expect(Number(n), `arithmetic says ${name} ${n}, table says ${tabled}`).toBe(tabled!);
    }
    // ...and the metamodel term is the one the filesystem can settle directly.
    expect(rows.get("conformance")).toBe(counts.fixtures);
  });

  test("AGENTS.md's fixture and corpora counts match", () => {
    const f = /\((\d+) fixtures;/.exec(agents);
    expect(f, "AGENTS.md no longer states '(N fixtures;'").not.toBeNull();
    expect(Number(f![1])).toBe(counts.fixtures);

    const c = /(\d+) shared corpora in total/.exec(agents);
    expect(c, "AGENTS.md no longer states 'N shared corpora in total'").not.toBeNull();
    expect(Number(c![1])).toBe(counts.corpora);
  });
});
