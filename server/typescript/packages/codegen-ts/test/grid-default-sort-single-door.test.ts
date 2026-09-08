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

/**
 * The sanctioned readers of the grid's sort attrs — TWO, and the second is not a
 * concession, it is the package boundary.
 *
 * `filter-shared.ts` is the resolver every server-side generator routes through.
 * `grid-from-metadata.ts` is its runtime twin: `buildGrid()` answers the SAME question
 * (a grid's initial sort) for a browser that builds its grid at runtime instead of
 * generating it. It cannot import the resolver — `runtime-web` is the pure browser core
 * and may depend only on `@metaobjectsdev/metadata` (#287: one value import from the
 * wrong entry point made every browser bundle fail), while `filter-shared.ts` lives in a
 * SERVER package. So the rule is implemented exactly twice, deliberately, and both are
 * listed here with the requirement that each keeps reading the attrs.
 *
 * Excluding `client/web` from the scan entirely — which this gate did — rested on the
 * claim that the runtime read is "a different tier answering a different question
 * (`?sort=field` from a client, not a grid's initial state)". That is true of the fetcher
 * and false of `buildGrid`, which computes precisely a grid's initial state; it read only
 * `@defaultSortOrder` and so returned ascending for a grid the generated code sorted
 * descending. A gate that scopes itself by a rationale it has not checked reports clean
 * about a tree it never looked at.
 */
const SANCTIONED = [
  "server/typescript/packages/codegen-ts/src/templates/filter-shared.ts",
  "client/web/packages/runtime-web/src/grid-from-metadata.ts",
] as const;

/**
 * Source trees that could implement a grid's initial sort.
 *
 * Scoped to `src/` of the generator packages plus the browser runtime core, not the whole
 * repo: `spec/` and the metadata provider definitions NAME these attrs to register them
 * (that is their job, not a second implementation).
 */
const TREES = [
  "server/typescript/packages/codegen-ts/src",
  "server/typescript/packages/codegen-ts-tanstack/src",
  "server/typescript/packages/codegen-ts-react/src",
  "server/typescript/packages/codegen-ts-angular/src",
  "client/web/packages/runtime-web/src",
] as const;

/**
 * The two attrs that together answer "which way does this grid sort initially", each
 * paired with the `MetaLayout` convenience getter that returns the SAME value.
 *
 * Matching only `attr(CONSTANT)` left a live bypass: `MetaLayout` exposes
 * `defaultSortField` / `defaultSortOrder` getters, and a generator reaching for
 * `l.defaultSortOrder` hand-rolls the rule while passing this gate silently. That is not a
 * hypothetical route — `grid-hook-file.ts` already reads `l.pageSize` and `l.filter`
 * through those same getters, so it is the most natural way to write the next second door.
 */
const GRID_SORT_ATTRS = [
  { constant: "LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD", getter: "defaultSortField" },
  { constant: "LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER", getter: "defaultSortOrder" },
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
    // …and the browser twin, the tree this gate used to skip entirely.
    expect(names).toContain("client/web/packages/runtime-web/src/grid-from-metadata.ts");
  });

  for (const { constant, getter } of GRID_SORT_ATTRS) {
    test(`only the sanctioned readers read ${constant}`, () => {
      // Two spellings of the same READ: `<node>.attr(CONSTANT)` and the `MetaLayout`
      // convenience getter `<node>.<getter>` that wraps it. Matching a bare mention of the
      // constant instead would point a failure at the multi-line `import { ... }` block's
      // member lines rather than at the call site that is the actual second door — a gate
      // that names the wrong line trains its reader to distrust it.
      const read = new RegExp(`attr\\s*\\(\\s*${constant}\\s*\\)|\\.${getter}\\b`);
      const readers = scanned
        .map((f) => ({ path: relative(REPO, f).replaceAll("\\", "/"), text: readFileSync(f, "utf8") }))
        .filter((f) => !SANCTIONED.includes(f.path as (typeof SANCTIONED)[number]))
        .map((f) => ({ ...f, uses: f.text.split("\n").filter((line) => read.test(line)) }))
        .filter((f) => f.uses.length > 0);

      expect(
        readers.map((r) => `${r.path}:${r.uses[0]!.trim()}`).join("\n"),
        `${constant} (or the .${getter} getter that wraps it) read outside the sanctioned ` +
        `readers — route it through resolveGridDefaultSort() instead, or the new door will ` +
        `disagree with the grid const, the hook, and the generated agent page.`,
      ).toBe("");
    });
  }

  for (const sanctioned of SANCTIONED) {
    test(`the sanctioned reader ${sanctioned.split("/").pop()} still reads both attrs`, () => {
      // Guards the vacuous-pass case: if a sanctioned reader stopped reading the attrs,
      // "nobody reads them" would satisfy every test above while grids silently lost their
      // initial sort. Something MUST read them — in BOTH tiers, since the two are
      // independent implementations and either can rot on its own.
      const text = readFileSync(resolve(REPO, sanctioned), "utf8");
      for (const { constant } of GRID_SORT_ATTRS) {
        expect(text, `${sanctioned} no longer reads ${constant}`).toContain(constant);
      }
    });
  }

  test("the server-side resolver is still the one the generators call", () => {
    const text = readFileSync(resolve(REPO, SANCTIONED[0]), "utf8");
    expect(text).toContain("resolveGridDefaultSort");
  });
});
