// FR-017 Tier 4 — TPH single-table schema emission.
//
// A discriminator-bearing base (@discriminator) emits ONE physical table whose
// columns are the union of the base's own fields + every concrete subtype's own
// fields, with the subtype-only columns forced NULLABLE (a row of any other
// subtype stores NULL there) even when the field is @required. Subtype entities
// (@discriminatorValue) emit NO table of their own — TPH is single-table.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadTph() {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            { "object.entity": { name: "Auth", "@discriminator": "type", children: [
              { "source.rdb": { "@table": "auths" } },
              { "field.long": { name: "id" } },
              { "field.enum": { name: "type", "@values": ["Bridge", "Copay", "PriorAuth"] } },
              { "field.string": { name: "reference", "@required": true, "@maxLength": 80 } },
              { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            ]}},
            { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge", children: [
              { "field.int": { name: "quantity", "@required": true } },
            ]}},
            { "object.entity": { name: "CopayAuth", extends: "Auth", "@discriminatorValue": "Copay", children: [
              { "field.decimal": { name: "copayAmount", "@precision": 10, "@scale": 2 } },
            ]}},
            { "object.entity": { name: "PriorAuthAuth", extends: "Auth", "@discriminatorValue": "PriorAuth", children: [
              { "field.string": { name: "approver", "@maxLength": 80 } },
            ]}},
          ],
        },
      }),
    ),
  ]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.root;
}

describe("buildExpectedSchema — TPH single table", () => {
  test("emits ONE base table; subtypes emit no table of their own", async () => {
    const snap = buildExpectedSchema(await loadTph(), { dialect: "postgres" });
    const names = snap.tables.map((t) => t.name).sort();
    expect(names).toContain("auths");
    expect(names).not.toContain("bridge_auths");
    expect(names).not.toContain("copay_auths");
    expect(names).not.toContain("prior_auth_auths");
    // exactly one table
    expect(snap.tables.length).toBe(1);
  });

  test("the single table unions base + every subtype's own columns", async () => {
    const snap = buildExpectedSchema(await loadTph(), { dialect: "postgres" });
    const auths = snap.tables.find((t) => t.name === "auths")!;
    const cols = auths.columns.map((c) => c.name).sort();
    expect(cols).toEqual(["approver", "copay_amount", "id", "quantity", "reference", "type"]);
  });

  test("subtype-only columns are NULLABLE even when the field is @required", async () => {
    const snap = buildExpectedSchema(await loadTph(), { dialect: "postgres" });
    const auths = snap.tables.find((t) => t.name === "auths")!;
    const quantity = auths.columns.find((c) => c.name === "quantity")!;
    // quantity is @required on BridgeAuth, but must be nullable in the single table.
    expect(quantity.nullable).toBe(true);
    const copay = auths.columns.find((c) => c.name === "copay_amount")!;
    expect(copay.nullable).toBe(true);
  });

  test("base-owned required column keeps its NOT NULL", async () => {
    const snap = buildExpectedSchema(await loadTph(), { dialect: "postgres" });
    const auths = snap.tables.find((t) => t.name === "auths")!;
    const reference = auths.columns.find((c) => c.name === "reference")!;
    expect(reference.nullable).toBe(false);
  });
});
