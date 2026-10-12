// Every OWNED copy of a reference template in this repo must BE what `meta eject` writes.
//
// `meta init` / `meta eject` hand an adopter a generator and the template modules it calls
// (ADR-0034 Amendment 8): `codegen/generators/<name>.ts` and `codegen/templates/`. This repo
// carries owned copies of its own — the `test-generators` package, and one set per example
// under `examples/*/codegen/` — because 1.0 removed the four ownable generators from
// `@metaobjectsdev/codegen-ts/generators`. If a copy drifts, the suites and examples keep
// passing while proving nothing about what an adopter runs. That is ADR-0034's byte-identity
// blindness one level out, so it gets the same treatment.
//
// The copy set is DISCOVERED, not listed: a new owned copy added anywhere this scans is
// guarded the moment it lands, and cannot be added unguarded by forgetting a line here. The
// expected content is the SAME definition the sync script writes from
// (`scripts/sync-owned-template-copies.ts`), so the gate and its fix cannot disagree.
//
// This lives in `cli`, the package that owns `meta eject`: the expected form is the eject's.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { OWNED_TEMPLATES_DIR } from "../src/lib/template-eject.js";
import { ownedTiers, expectedFor } from "./support/owned-tiers.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

function tsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

describe("owned reference-template copies are what `meta eject` writes", () => {
  const tiers = ownedTiers(REPO_ROOT);

  test("the scan finds this package's copies AND at least one example's", () => {
    // A scan that silently found nothing would pass every assertion below.
    expect(tiers.length).toBeGreaterThanOrEqual(2);
  });

  for (const tier of tiers) {
    const where = relative(REPO_ROOT, tier.generators);
    const expected = expectedFor(tier);

    test(`${where} holds at least one owned copy`, () => {
      expect(expected.generators.size).toBeGreaterThan(0);
    });

    for (const [path, content] of expected.generators) {
      test(`${relative(REPO_ROOT, path)}`, () => {
        expect(readFileSync(path, "utf8")).toBe(content);
      });
    }

    // The template modules the owned generators call: every one is there and is what eject
    // writes, and nothing else is — a module no generator calls any more is dead code here.
    for (const [path, content] of expected.templates) {
      test(`${relative(REPO_ROOT, path)}`, () => {
        expect(existsSync(path), `${relative(REPO_ROOT, path)} is missing`).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(content);
      });
    }

    test(`${relative(REPO_ROOT, tier.templates)} holds exactly the modules those generators call`, () => {
      const held = tsUnder(tier.templates).map((f) => relative(tier.templates, f));
      const wanted = [...expected.templates.keys()].map((f) => relative(tier.templates, f)).sort();
      expect(held).toEqual(wanted);
      // The copy is laid out where an adopter's is: `templates/` beside the generators', so
      // the `../templates/` specifier in every generator resolves.
      expect(relative(resolve(tier.generators, ".."), tier.templates)).toBe(OWNED_TEMPLATES_DIR.split("/")[1]!);
    });
  }
});

// ADR-0034 Amendment 3 (2026-09-24): an example that owns `entity` / `routes` also owns the
// HTTP-adapter source their output imports, under `codegen/runtime/`, copied verbatim from
// `@metaobjectsdev/runtime-ts/src`. Same blindness, same gate: a stale adapter copy would let
// an example keep "working" on code no adopter would get from `meta eject` today.
// Re-sync with `bun scripts/sync-owned-template-copies.ts`.
const RUNTIME_SRC = join(REPO_ROOT, "server", "typescript", "packages", "runtime-ts", "src");


describe("owned HTTP-adapter copies in the examples are byte-identical to runtime-ts/src", () => {
  const examples = join(REPO_ROOT, "examples");
  const roots = existsSync(examples)
    ? readdirSync(examples, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(examples, e.name, "codegen", "runtime"))
      .filter((d) => existsSync(d))
    : [];

  test("the scan finds at least one example's adapter copy", () => {
    expect(roots.length).toBeGreaterThan(0);
  });

  for (const root of roots) {
    for (const file of tsUnder(root)) {
      const rel = relative(root, file);
      test(`${relative(REPO_ROOT, file)}`, () => {
        expect(readFileSync(file, "utf8")).toBe(readFileSync(join(RUNTIME_SRC, rel), "utf8"));
      });
    }
  }
});
