// The `requirements` docs surface — shape C: the backlink on an entity's own page.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §4
//
// SHAPE C IS WHY THIS BEATS A STANDALONE SCRIPT. A hand-rolled registry generator can
// produce the index (shape A) from the ledger alone. Only something inside the codegen
// pipeline can add "this entity is claimed by these requirements" to the ENTITY's page,
// because only it holds both halves of the model at once.
//
// THE LOAD-BEARING TEST HERE IS THE NO-CHURN PIN, not the feature. This is the first task
// that modifies EXISTING `meta docs` output, so an unclaimed entity's page must come out
// byte-identical to what it produced before — otherwise every adopter's committed docs
// churn on upgrade for a feature they may not use.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import { buildEntityDocData } from "../src/generators/docs-data-builder.js";

const entityChildren = (table: string) => [
  { "field.long": { name: "id" } },
  { "field.string": { name: "label" } },
  { "source.rdb": { "@table": table } },
  { "identity.primary": { name: "pk", "@fields": ["id"] } },
];

const MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      { "object.entity": { name: "Order", children: entityChildren("orders") } },
      // Deliberately claimed by NOTHING — the no-churn pin's subject.
      { "object.entity": { name: "Audit", children: entityChildren("audits") } },
      // A value object claimed by a requirement. Object coverage is entity-grain
      // (capability-ledger.md), so this must gain NOTHING.
      {
        "object.value": {
          name: "Money",
          children: [{ "field.long": { name: "cents" } }],
        },
      },
      {
        "requirement.functional": {
          name: "checkout",
          "@level": 4,
          "@status": "live",
          "@statement": "A shopper can pay for a basket.",
          "@counterexample": "A basket that cannot be paid for.",
          "@implementedBy": ["acme::shop::Order"],
        },
      },
      {
        "requirement.functional": {
          name: "auditTrail",
          "@level": 4,
          "@status": "partial",
          "@statement": "Every order records who changed it.",
          "@counterexample": "An order whose last editor is unknown.",
          "@implementedBy": ["acme::shop::Order", "acme::shop::Money"],
        },
      },
    ],
  },
};

const NO_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      { "object.entity": { name: "Order", children: entityChildren("orders") } },
      { "object.entity": { name: "Audit", children: entityChildren("audits") } },
    ],
  },
};

async function loadRoot(model: unknown): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root as MetaRoot;
}

function objectNamed(root: MetaRoot, name: string): MetaObject {
  const found = root.children().find((c) => c.name === name);
  if (found === undefined) throw new Error(`no object named ${name}`);
  return found as MetaObject;
}

async function dataFor(model: unknown, name: string) {
  const root = await loadRoot(model);
  return buildEntityDocData(objectNamed(root, name), { dialect: "postgres", loadedRoot: root });
}

describe("shape C — requirement backlinks on the entity page", () => {
  test("a claimed entity gains its claiming requirements", async () => {
    const data = await dataFor(MODEL, "Order");
    expect(data.hasClaimedBy).toBe(true);
    const text = (data.claimedBy ?? []).map((c) => c.bullet).join("\n");
    expect(text).toContain("checkout");
    expect(text).toContain("A shopper can pay for a basket.");
  });

  test("an entity claimed by SEVERAL requirements lists all of them", async () => {
    const data = await dataFor(MODEL, "Order");
    expect(data.claimedBy).toHaveLength(2);
    const text = (data.claimedBy ?? []).map((c) => c.bullet).join("\n");
    expect(text).toContain("checkout");
    expect(text).toContain("auditTrail");
  });

  // THE NO-CHURN PIN. An unclaimed entity must be untouched — the gate flag absent, not
  // merely false, so the Mustache section does not render and the page bytes are
  // unchanged from before this feature existed.
  test("an UNCLAIMED entity gains nothing — gate flag and list both absent", async () => {
    const data = await dataFor(MODEL, "Audit");
    expect(data.hasClaimedBy).toBeUndefined();
    expect(data.claimedBy).toBeUndefined();
  });

  test("a model with NO ledger at all leaves every entity untouched", async () => {
    const order = await dataFor(NO_LEDGER, "Order");
    expect(order.hasClaimedBy).toBeUndefined();
    expect(order.claimedBy).toBeUndefined();
  });

  // Object coverage is entity-grain. A value legitimately carries no claim of its own,
  // and surfacing one here would imply a coverage rule the ledger does not have.
  test("a claimed object.value gains nothing — coverage is entity-grain", async () => {
    const data = await dataFor(MODEL, "Money");
    expect(data.hasClaimedBy).toBeUndefined();
    expect(data.claimedBy).toBeUndefined();
  });

  // Design §3 applies to every surface, not just the index.
  test("the backlink carries NO test link", async () => {
    const data = await dataFor(MODEL, "Order");
    const text = (data.claimedBy ?? []).map((c) => c.bullet).join("\n").toLowerCase();
    expect(text).not.toContain("verified");
    expect(text).not.toContain(".test.ts");
  });
});
