// F75 — the two halves of "does this run emit a client UI tier?" must agree.
//
// `agent/ui.md` gates on that answer. The declared half is each generator's
// `emitsUiTier` marker; the compatibility half is `UI_TIER_GENERATOR_NAMES`, which keeps
// a copy ejected before the marker existed from silently losing the page. A generator
// present in one half and not the other is the bug this file exists to catch: add a UI
// generator without the marker and the page stops emitting for everyone who wires it;
// add the marker without the name and an ejected copy of it degrades in silence.
//
// It lives in `cli` because `cli` is the second door onto the page (`meta docs`
// aggregates the same fact) and depends on the two PUBLISHED UI codegen packages.
//
// It does NOT cover the three `angular-*` names: `codegen-ts-angular` is source-only
// (ADR-0048), unpublished, and not a dependency of `cli`, so nothing here can import its
// generators. They do carry `emitsUiTier: true` — the gate simply cannot see them, and
// saying so is the point: the set below is 4 of the 7 names, not all of them. Closing
// that needs a devDependency on a source-only package, which is a build decision that
// belongs with the ADR's promotion bar rather than with this gate.

import { describe, test, expect } from "bun:test";
import { UI_TIER_GENERATOR_NAMES } from "@metaobjectsdev/codegen-ts";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "@metaobjectsdev/codegen-ts-tanstack";

const SHIPPED: Generator[] = [formFile(), tanstackQuery(), tanstackGrid(), tanstackGridHook()];

describe("UI-tier marker parity", () => {
  test("every shipped UI generator declares emitsUiTier", () => {
    expect(SHIPPED.map((g) => [g.name, g.emitsUiTier])).toEqual(
      SHIPPED.map((g) => [g.name, true]),
    );
  });

  test("every shipped UI generator's name is in the ejected-copy compatibility set", () => {
    expect(SHIPPED.filter((g) => !UI_TIER_GENERATOR_NAMES.has(g.name)).map((g) => g.name))
      .toEqual([]);
  });

  test("every name in the compatibility set is accounted for", () => {
    // The other direction of the same parity: a name in the set with no shipped generator
    // behind it is either a typo or a generator that was renamed and left a stale entry —
    // and an entry matching nothing silently stops covering the ejected copy it was for.
    // The angular names are named explicitly rather than filtered out by pattern, so
    // adding a fourth unreachable name fails here instead of being absorbed.
    const reachable = SHIPPED.map((g) => g.name);
    const unreachable = [...UI_TIER_GENERATOR_NAMES].filter((n) => !reachable.includes(n));
    expect(unreachable.sort()).toEqual(["angular-form", "angular-grid", "angular-service"]);
  });
});
