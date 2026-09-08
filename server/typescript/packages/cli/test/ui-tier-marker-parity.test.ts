// F75 — the two halves of "does this run emit a client UI tier?" must agree.
//
// `agent/ui.md` gates on that answer. The declared half is each generator's
// `emitsUiTier` marker; the compatibility half is `UI_TIER_GENERATOR_NAMES`, which keeps
// a copy ejected before the marker existed from silently losing the page. A generator
// present in one half and not the other is the bug this file exists to catch: add a UI
// generator without the marker and the page stops emitting for everyone who wires it;
// add the marker without the name and an ejected copy of it degrades in silence.
//
// It lives in `cli` because `cli` is the only package that depends on every UI codegen
// package AND is the second door onto the page (`meta docs` aggregates the same fact).

import { describe, test, expect } from "bun:test";
import { UI_TIER_GENERATOR_NAMES, runEmitsUiTier } from "@metaobjectsdev/codegen-ts";
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

  test("the shipped suite makes the run emit a UI tier; a server-only suite does not", () => {
    expect(runEmitsUiTier(SHIPPED)).toBe(true);
    expect(runEmitsUiTier([{ name: "entity-file", generate: () => [] }])).toBe(false);
  });
});
