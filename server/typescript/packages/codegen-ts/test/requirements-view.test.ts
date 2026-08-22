// The `requirements` docs surface — the projected row the renderers bind to.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md
//
// This projects over `walkRequirements()` rather than re-walking, so the docs
// surface and the `requirementTests()` stub generator agree about what the ledger
// contains BY CONSTRUCTION. Two walks kept in step by hand is the drift this
// avoids.
//
// The fixture is shaped around the two ways this projection fails SILENTLY:
//   - NESTING. A flat ledger cannot tell a depth-first walk from a top-level-only
//     one — both return the same rows. `payment` nests under `checkout`, and
//     `capture` under `payment`, so a walk that stops at the root loses two rows
//     and a walk that loses depth mis-renders the whole document.
//   - `notes`. A requirement carrying ONLY `description` cannot tell suppression
//     from absence. `checkout` carries BOTH, so a projection that leaks `notes`
//     into user-facing output has somewhere to leak from.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { requirementRows } from "../src/generators/requirements-view.js";

const NOTES_SENTINEL = "INTERNAL-ONLY-SENTINEL-must-never-be-emitted";

const MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "checkout",
          "@level": 2,
          "@status": "live",
          "@statement": "A shopper can pay for a basket.",
          "@counterexample": "A basket that cannot be paid for.",
          "@description": "Covers the payment path, not fulfilment.",
          "@notes": NOTES_SENTINEL,
          children: [
            {
              "requirement.functional": {
                name: "payment",
                "@level": 3,
                "@status": "live",
                "@statement": "Payment is captured exactly once.",
                "@counterexample": "A basket charged twice.",
                children: [
                  {
                    "requirement.functional": {
                      name: "capture",
                      "@level": 4,
                      "@status": "partial",
                      "@statement": "An order records what was captured.",
                      "@counterexample": "An order that cannot say what was charged.",
                      "@implementedBy": ["acme::shop::Order"],
                      "@trackedBy": ["#412"],
                      "@disposition": "accepted",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

const EMPTY_MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

async function load(model: unknown): Promise<MetaData> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root;
}

describe("requirementRows — the docs projection", () => {
  test("projects EVERY nested requirement, not just the root-level ones", async () => {
    const rows = requirementRows(await load(MODEL));
    expect(rows.map((r) => r.path)).toEqual([
      "checkout",
      "checkout.payment",
      "checkout.payment.capture",
    ]);
  });

  test("carries depth, so a renderer can reproduce the hierarchy", async () => {
    const rows = requirementRows(await load(MODEL));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  test("projects the prescriptive attrs a reader needs", async () => {
    const rows = requirementRows(await load(MODEL));
    const capture = rows.find((r) => r.path === "checkout.payment.capture");
    expect(capture).toBeDefined();
    expect(capture?.level).toBe(4);
    expect(capture?.status).toBe("partial");
    expect(capture?.subType).toBe("functional");
    expect(capture?.statement).toBe("An order records what was captured.");
    expect(capture?.counterexample).toBe("An order that cannot say what was charged.");
    expect(capture?.disposition).toBe("accepted");
    expect(capture?.trackedBy).toEqual(["#412"]);
  });

  test("resolves @implementedBy to its claimed targets", async () => {
    const rows = requirementRows(await load(MODEL));
    const capture = rows.find((r) => r.path === "checkout.payment.capture");
    expect(capture?.implementedBy).toEqual(["acme::shop::Order"]);
    expect(capture?.claimedConcerns).toEqual(["object.entity"]);
  });

  test("emits `description` — it is chartered user-facing", async () => {
    const rows = requirementRows(await load(MODEL));
    const checkout = rows.find((r) => r.path === "checkout");
    expect(checkout?.description).toBe("Covers the payment path, not fulfilment.");
  });

  // documentation.json:39 — `notes` is the internal-only slot, never emitted to a
  // user-facing doc surface. The sentinel must not appear on ANY projected value,
  // not merely be absent from a `notes` property nobody declared.
  test("NEVER projects `notes`, on any field of any row", async () => {
    const rows = requirementRows(await load(MODEL));
    expect(JSON.stringify(rows)).not.toContain(NOTES_SENTINEL);
  });

  test("a model with no requirement nodes projects nothing", async () => {
    expect(requirementRows(await load(EMPTY_MODEL))).toEqual([]);
  });
});
