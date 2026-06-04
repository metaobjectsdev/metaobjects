// FR-017 Tier 4 — runtime TPH support in ObjectManager.
//
// The runtime ObjectManager must operate on table-per-hierarchy SUBTYPE
// entities, not just the discriminator base. A subtype:
//   - resolves its INHERITED fields / identity / source (the single base table)
//     via the metadata effective-children (super) chain;
//   - injects the discriminator value on create (the URL/entity names the
//     subtype, the caller never sets it);
//   - is SCOPED to its discriminator on every read/update/delete — a row of a
//     different subtype is invisible (findById → null, update/delete → not
//     found), mirroring the generated per-subtype route's cross-subtype 404;
//   - rejects a cross-subtype-only column (it's not a field of this subtype);
//   - cannot change its discriminator (stripped from an update patch).
// The discriminator base reads polymorphically (all rows, tagged by value).

import { describe, test, expect, beforeEach } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaData } from "@metaobjectsdev/metadata";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import { NotFoundError } from "../src/errors.js";

const TPH_META = JSON.stringify({
  "metadata.root": {
    package: "demo",
    children: [
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "type",
          children: [
            { "source.rdb": { "@table": "auths" } },
            { "field.long": { name: "id" } },
            { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
            { "field.string": { name: "reference", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "BridgeAuth",
          extends: "Auth",
          "@discriminatorValue": "Bridge",
          children: [{ "field.int": { name: "quantity", "@required": true } }],
        },
      },
      {
        "object.entity": {
          name: "CopayAuth",
          extends: "Auth",
          "@discriminatorValue": "Copay",
          children: [{ "field.decimal": { name: "copayAmount", "@precision": 10, "@scale": 2 } }],
        },
      },
    ],
  },
});

async function loadRoot(): Promise<MetaData> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([new InMemoryStringSource(TPH_META, { id: "auth.json" })]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  return root;
}

let om: ObjectManager;

beforeEach(async () => {
  const root = await loadRoot();
  const driver = inMemoryDriver({
    seed: {
      auths: [
        { id: 1, type: "Bridge", reference: "REF-1", quantity: 5, copay_amount: null },
        { id: 2, type: "Copay", reference: "REF-2", quantity: null, copay_amount: "12.50" },
      ],
    },
    pkFields: { auths: ["id"] },
  });
  om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "snake_case" });
});

describe("ObjectManager TPH — subtype field/identity/source resolution (effective children)", () => {
  test("findById on a subtype resolves the inherited PK + table + base fields", async () => {
    const row = await om.findById("BridgeAuth", 1);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(1);
    expect(row!.type).toBe("Bridge");
    expect(row!.reference).toBe("REF-1");
    expect(row!.quantity).toBe(5);
  });

  test("base entity reads polymorphically (all rows, tagged by discriminator)", async () => {
    const rows = await om.findMany("Auth", undefined, { orderBy: [["id", "asc"]] });
    expect(rows.map((r) => r.type)).toEqual(["Bridge", "Copay"]);
  });
});

describe("ObjectManager TPH — discriminator scoping", () => {
  test("findById is scoped to the subtype — a different-subtype row is invisible (null)", async () => {
    // id 2 is a Copay; addressing it through BridgeAuth must NOT return it.
    expect(await om.findById("BridgeAuth", 2)).toBeNull();
  });

  test("findMany on a subtype returns only that subtype's rows", async () => {
    const rows = await om.findMany("BridgeAuth", undefined, { orderBy: [["id", "asc"]] });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  test("count on a subtype counts only that subtype's rows", async () => {
    expect(await om.count("BridgeAuth")).toBe(1);
    expect(await om.count("CopayAuth")).toBe(1);
  });
});

describe("ObjectManager TPH — create injects the discriminator", () => {
  test("create on a subtype injects the discriminator value (caller omits it)", async () => {
    const created = await om.create("BridgeAuth", { reference: "REF-NEW", quantity: 9 });
    expect(created.type).toBe("Bridge");
    expect(created.reference).toBe("REF-NEW");
    expect(created.quantity).toBe(9);
    expect(created.id).toBe(3);
  });

  test("a cross-subtype-only column is rejected (not a field of this subtype)", async () => {
    await expect(om.create("BridgeAuth", { reference: "X", quantity: 1, copayAmount: "1.00" })).rejects.toThrow();
  });
});

describe("ObjectManager TPH — update/delete are subtype-scoped + discriminator-immutable", () => {
  test("update a subtype-only column", async () => {
    const updated = await om.update("BridgeAuth", 1, { quantity: 50 });
    expect(updated).not.toBeNull();
    expect(updated!.quantity).toBe(50);
    expect(updated!.type).toBe("Bridge");
  });

  test("update is scoped — patching a different subtype's row is not found", async () => {
    // id 2 is a Copay; through BridgeAuth it's invisible → not found (default
    // ifMissing="throw"), exactly like updating a non-existent id.
    await expect(om.update("BridgeAuth", 2, { quantity: 99 })).rejects.toThrow(NotFoundError);
    // With ifMissing="ignore" the scoped-out row resolves to null, not the row.
    expect(await om.update("BridgeAuth", 2, { quantity: 99 }, { ifMissing: "ignore" })).toBeNull();
  });

  test("update cannot change the discriminator (stripped from the patch)", async () => {
    const updated = await om.update("BridgeAuth", 1, { type: "Copay", quantity: 7 } as Record<string, unknown>);
    expect(updated).not.toBeNull();
    expect(updated!.type).toBe("Bridge");
    expect(updated!.quantity).toBe(7);
  });

  test("delete is scoped — deleting a different subtype's row is not found", async () => {
    // id 2 is a Copay; through BridgeAuth it's invisible → not found.
    await expect(om.delete("BridgeAuth", 2)).rejects.toThrow(NotFoundError);
    expect(await om.delete("BridgeAuth", 2, { ifMissing: "ignore" })).toBe(false);
    // the Copay row is still there
    expect(await om.findById("CopayAuth", 2)).not.toBeNull();
  });

  test("delete removes the subtype's own row", async () => {
    expect(await om.delete("BridgeAuth", 1)).toBe(true);
    expect(await om.findById("BridgeAuth", 1)).toBeNull();
  });
});
