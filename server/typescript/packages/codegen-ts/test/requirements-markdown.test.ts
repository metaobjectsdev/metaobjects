// The `requirements` docs surface — the human-facing markdown index (shape A).
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §4, §5
//
// Renders from RequirementRow, so `notes` is unreachable by construction — the
// projection does not carry it. The tests below still assert its absence at THIS
// tier, because "unreachable by construction" is a property of today's projection
// and this renderer outlives that guarantee if anyone ever widens the row.

import { describe, test, expect } from "bun:test";
import { renderRequirementsMarkdown } from "../src/generators/requirements-markdown.js";
import type { RequirementRow } from "../src/generators/requirements-view.js";

const row = (over: Partial<RequirementRow> & Pick<RequirementRow, "path" | "depth">): RequirementRow => ({
  subType: "functional",
  level: undefined,
  status: undefined,
  disposition: undefined,
  trackedBy: [],
  statement: undefined,
  counterexample: undefined,
  description: undefined,
  implementedBy: [],
  claimedConcerns: [],
  ...over,
});

const ROWS: RequirementRow[] = [
  row({
    path: "checkout",
    depth: 0,
    level: 2,
    status: "live",
    statement: "A shopper can pay for a basket.",
    counterexample: "A basket that cannot be paid for.",
    description: "Covers the payment path, not fulfilment.",
  }),
  row({
    path: "checkout.payment",
    depth: 1,
    level: 3,
    status: "live",
    statement: "Payment is captured exactly once.",
    counterexample: "A basket charged twice.",
  }),
  row({
    path: "checkout.payment.capture",
    depth: 2,
    level: 4,
    status: "partial",
    disposition: "accepted",
    trackedBy: ["#412"],
    statement: "An order records what was captured.",
    counterexample: "An order that cannot say what was charged.",
    implementedBy: ["acme::shop::Order"],
    claimedConcerns: ["object.entity"],
  }),
];

describe("renderRequirementsMarkdown", () => {
  test("renders nesting as heading depth, so the hierarchy survives", () => {
    const md = renderRequirementsMarkdown(ROWS);
    expect(md).toContain("## checkout");
    expect(md).toContain("### checkout.payment");
    expect(md).toContain("#### checkout.payment.capture");
  });

  test("carries the prescriptive pair — what should be true, and what breaking it looks like", () => {
    const md = renderRequirementsMarkdown(ROWS);
    expect(md).toContain("A shopper can pay for a basket.");
    expect(md).toContain("A basket that cannot be paid for.");
  });

  test("renders level, status, disposition and tracking references", () => {
    const md = renderRequirementsMarkdown(ROWS);
    expect(md).toContain("L4");
    expect(md).toContain("partial");
    expect(md).toContain("accepted");
    expect(md).toContain("#412");
  });

  test("renders resolved claims", () => {
    const md = renderRequirementsMarkdown(ROWS);
    expect(md).toContain("acme::shop::Order");
  });

  test("emits `description` — chartered user-facing", () => {
    const md = renderRequirementsMarkdown(ROWS);
    expect(md).toContain("Covers the payment path, not fulfilment.");
  });

  // Design §3. There is no join key, so there is nothing honest to print. A reader
  // must not be able to mistake silence here for "this has no tests" OR for "tested".
  test("prints NO test link, under any input", () => {
    const md = renderRequirementsMarkdown(ROWS).toLowerCase();
    expect(md).not.toContain("verifiedby");
    expect(md).not.toContain("verified by");
    expect(md).not.toContain(".test.ts");
  });

  // Task 4 depends on this: the generator emits NOTHING for an empty ledger rather
  // than an empty page, and that is what makes turning the surface on by default a
  // no-op for every project without requirements.
  test("an empty ledger renders the empty string, not a headed but empty document", () => {
    expect(renderRequirementsMarkdown([])).toBe("");
  });

  test("a requirement with only a statement renders without undefined leaking in", () => {
    const md = renderRequirementsMarkdown([row({ path: "bare", depth: 0, statement: "It holds." })]);
    expect(md).toContain("It holds.");
    expect(md).not.toContain("undefined");
  });
});
