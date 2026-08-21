// The `requirements` docs surface — the machine-facing TOON artifact.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §5
//
// TOON WAS CHOSEN FOR THE DECLARED-COUNT HEADER, NOT THE TOKEN SAVING. Measured on 321
// rows it is 42.1% smaller than JSON but only 7.3% smaller than a markdown table — a
// table is already header-once, so compression is nearly absent as an argument. What it
// buys is `requirements[N]{...}:`, letting a reader verify it received all N rows.
//
// So the count test below is not a formatting assertion. It is the ONLY reason this
// file exists, and it is the thing that fails silently if the walk ever loses rows.

import { describe, test, expect } from "bun:test";
import { renderRequirementsToon } from "../src/generators/requirements-toon.js";
import type { RequirementRow } from "../src/generators/requirements-view.js";

const row = (over: Partial<RequirementRow> & Pick<RequirementRow, "path" | "depth">): RequirementRow => ({
  subType: "functional",
  level: undefined,
  status: undefined,
  disposition: undefined,
  trackedBy: [],
  statement: undefined,
  violation: undefined,
  description: undefined,
  implementedBy: [],
  claimedConcerns: [],
  ...over,
});

// Three levels of NESTING. A flat fixture cannot tell a depth-first walk from a
// top-level-only one — both would emit a plausible count — so the count assertion is
// only meaningful over nested input.
const ROWS: RequirementRow[] = [
  row({ path: "checkout", depth: 0, level: 2, status: "live", statement: "A shopper can pay." }),
  row({ path: "checkout.payment", depth: 1, level: 3, status: "live", statement: "Captured once." }),
  row({
    path: "checkout.payment.capture",
    depth: 2,
    level: 4,
    status: "partial",
    statement: "An order records what was captured, and by whom.",
    implementedBy: ["acme::shop::Order"],
  }),
];

describe("renderRequirementsToon", () => {
  test("declares the row count in its header — the reason this format was chosen", () => {
    const toon = renderRequirementsToon(ROWS);
    expect(toon).toContain("requirements[3]");
  });

  test("the DECLARED count equals the number of rows actually emitted", () => {
    const toon = renderRequirementsToon(ROWS);
    const declared = Number(/requirements\[(\d+)\]/.exec(toon)?.[1]);
    // Every emitted row carries its dotted path, so counting paths counts rows without
    // depending on how the encoder lays out any other field.
    const emitted = ROWS.filter((r) => toon.includes(r.path)).length;
    expect(declared).toBe(ROWS.length);
    expect(emitted).toBe(ROWS.length);
  });

  test("includes nested rows, not just root-level ones", () => {
    const toon = renderRequirementsToon(ROWS);
    expect(toon).toContain("checkout.payment.capture");
  });

  // TOON quotes comma-bearing strings. Asserted rather than assumed: if the encoder's
  // quoting ever changed, a statement would silently split into extra columns and the
  // artifact would misparse while still looking well-formed.
  test("prose containing a comma survives encoding intact", () => {
    const toon = renderRequirementsToon(ROWS);
    expect(toon).toContain("An order records what was captured, and by whom.");
  });

  test("an empty ledger renders the empty string", () => {
    expect(renderRequirementsToon([])).toBe("");
  });
});
