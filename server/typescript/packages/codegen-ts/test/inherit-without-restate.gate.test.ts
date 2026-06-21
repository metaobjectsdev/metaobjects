// GATE / TRIPWIRE for issue #56 — codegen must read inherited attributes via the
// EFFECTIVE accessor (attr / attrs), not the OWN-ONLY accessor (ownAttr).
//
// These tests assert the CORRECT behavior and are RED until #56 is fixed. When the
// ownAttr→attr fix lands, they go green and this becomes the permanent regression gate.
// See issue #56 for the full cross-port inventory of own-only reads.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildPkMap } from "../src/pk-resolver.js";

async function loadModel(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("inherit-without-restate gate (#56)", () => {
  // An identity.primary that inherits @fields via node-level `extends` (ADR-0029) without
  // restating it. pk-resolver.ts reads primary.ownAttr(@fields) → undefined → the entity
  // is silently dropped from the PK map → generated schema has NO primary key.
  test("identity.primary extends a base identity (no @fields restated) still yields a PK", async () => {
    const root = await loadModel([
      {
        "object.entity": {
          name: "BaseEntity",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": { "@table": "widgets" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "primary", extends: "test::BaseEntity.primary" } },
          ],
        },
      },
    ]);

    const widget = root.objects().find((o) => o.name === "Widget")!;
    const primary = widget.ownChildren().find((c) => c.type === "identity")!;

    // Root cause documented: effective sees the inherited value; own-only does not.
    expect(primary.attr("fields")).toEqual(["id"]);
    expect(primary.ownAttr("fields")).toBeUndefined();

    // The gate: the entity must have a primary key. RED until #56 is fixed
    // (pk-resolver currently drops Widget because it reads ownAttr(@fields)).
    const pkMap = buildPkMap(root);
    expect([...pkMap.keys()]).toContain("Widget");
  });
});
