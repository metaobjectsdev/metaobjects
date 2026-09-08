// One rule, one door: the grid's initial sort direction has exactly ONE reader.
//
// `@sortableDefaultOrder` shipped with a write side (it lands in the generated
// <Entity>SortAllowlist), an emitted allowlist entry, and NO read at all — one door in,
// no door out. When the read finally landed it landed at the runtime, and three codegen
// sites went on answering the question their own way: the columns file emitted a sort
// only when BOTH layout attrs were present, the grid hook folded a missing order to
// ascending, and the generated agent UI page printed no direction at all. Three doors,
// three answers, one declaration — and a fixture that declared both attrs, so none of
// them could be seen disagreeing.
//
// The fix routes all three through `resolveGridDefaultSort`. This test is what keeps that
// true, because the tempting regression is the next emitter reading
// `layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER)` directly — it looks correct, it
// passes on the both-attrs-present fixture, and it is silently wrong for the model the
// contract describes.
//
// DERIVED, not a hand-kept list: it discovers its own subject set by walking the source
// trees and asks which files name the attrs, so a new generator or template that
// hand-rolls the answer appears here with no edit to this file. A hand-kept allowlist of
// permitted call sites would be the same defect one level up — a list someone has to
// remember to extend, which is exactly how three doors stayed unlisted.
//
// It asserts on FILE CONTENT over the source tree rather than on behaviour, because the
// question is "is there a second implementation of this rule", and behaviour tests can
// only ask about the implementations someone thought to write a case for.

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");

/** The resolver is the ONE sanctioned reader of the grid's sort attrs. */
const SANCTIONED = "server/typescript/packages/codegen-ts/src/templates/filter-shared.ts";

/**
 * Source trees that could implement a grid's initial sort.
 *
 * Scoped to `src/` of the generator packages, not the whole repo: `spec/` and the
 * metadata provider definitions NAME these attrs to register them (that is their job,
 * not a second implementation), and the runtime read is a different tier answering a
 * different question (`?sort=field` from a client, not a grid's initial state) — it is
 * gated by the api-contract corpus instead, which drives it over real HTTP.
 */
const TREES = [
  "server/typescript/packages/codegen-ts/src",
  "server/typescript/packages/codegen-ts-tanstack/src",
  "server/typescript/packages/codegen-ts-react/src",
  "server/typescript/packages/codegen-ts-angular/src",
] as const;

/** The two attrs that together answer "which way does this grid sort initially". */
const GRID_SORT_ATTRS = [
  "LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD",
  "LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER",
] as const;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("the grid's initial sort has exactly one reader", () => {
  // Fail-closed on the subject set itself: an empty scan would make every assertion
  // below vacuously true, which is how a gate reports "clean" while checking nothing.
  const scanned = TREES.flatMap((t) => tsFiles(resolve(REPO, t)));
  test("the scan actually found generator sources", () => {
    expect(scanned.length).toBeGreaterThan(20);
    // And specifically: the files this fix had to change are in the set.
    const names = scanned.map((f) => relative(REPO, f).replaceAll("\\", "/"));
    expect(names).toContain("server/typescript/packages/codegen-ts-tanstack/src/templates/columns-file.ts");
    expect(names).toContain("server/typescript/packages/codegen-ts-tanstack/src/templates/grid-hook-file.ts");
    expect(names).toContain("server/typescript/packages/codegen-ts/src/generators/agent-ui-page.ts");
  });

  for (const attr of GRID_SORT_ATTRS) {
    test(`only the resolver reads ${attr}`, () => {
      // The READ is `<node>.attr(CONSTANT)`, so that is the pattern matched. Matching a
      // bare mention instead would point a failure at the multi-line `import { ... }`
      // block's member lines rather than at the call site that is the actual second
      // door — a gate that names the wrong line trains its reader to distrust it.
      const read = new RegExp(`attr\\s*\\(\\s*${attr}\\s*\\)`);
      const readers = scanned
        .map((f) => ({ path: relative(REPO, f).replaceAll("\\", "/"), text: readFileSync(f, "utf8") }))
        .filter((f) => f.path !== SANCTIONED)
        .map((f) => ({ ...f, uses: f.text.split("\n").filter((line) => read.test(line)) }))
        .filter((f) => f.uses.length > 0);

      expect(
        readers.map((r) => `${r.path}:${r.uses[0]!.trim()}`).join("\n"),
        `${attr} read outside the sanctioned resolver — route it through ` +
        `resolveGridDefaultSort() instead, or the new door will disagree with the ` +
        `grid const, the hook, and the generated agent page.`,
      ).toBe("");
    });
  }

  test("the sanctioned resolver itself reads both", () => {
    // Guards the vacuous-pass case: if the resolver stopped reading the attrs, "nobody
    // reads them" would satisfy both tests above and every grid would silently lose its
    // initial sort. Something MUST read them, somewhere.
    const text = readFileSync(resolve(REPO, SANCTIONED), "utf8");
    for (const attr of GRID_SORT_ATTRS) {
      expect(text, `resolver no longer reads ${attr}`).toContain(attr);
    }
    expect(text).toContain("resolveGridDefaultSort");
  });
});
