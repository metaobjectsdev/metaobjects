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
              { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
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

  // A TPH subtype-only column must carry NO DB default, for the same reason it is
  // forced nullable: every row of every OTHER subtype stores NULL there. A DEFAULT
  // defeats that — a sibling subtype's INSERT omits the column and silently takes
  // the default instead of NULL. codegen states this intent outright (the
  // `forceNullable` parameter in drizzle-schema.ts: "force nullable (drop
  // .notNull()) and suppress any DB default") and honours it, so migrate emitting
  // one puts a DEFAULT in the database that the app's Drizzle schema does not know
  // about. `verify --db` cannot catch the disagreement because migrate and verify
  // share this expected schema.
  test("subtype-only columns carry NO default, even when the field declares one", async () => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "demo",
            children: [
              { "object.entity": { name: "Doc", "@discriminator": "kind", children: [
                { "source.rdb": { "@table": "docs" } },
                { "field.long": { name: "id" } },
                { "field.enum": { name: "kind", "@values": ["Draft", "Final"] } },
                { "field.string": { name: "title", "@required": true, "@maxLength": 80, "@default": "untitled" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
              ]}},
              { "object.entity": { name: "DraftDoc", extends: "Doc", "@discriminatorValue": "Draft", children: [
                { "field.int": { name: "revision", "@required": true, "@default": "1" } },
              ]}},
              { "object.entity": { name: "FinalDoc", extends: "Doc", "@discriminatorValue": "Final", children: [
                { "field.string": { name: "approver", "@maxLength": 80, "@default": "nobody" } },
              ]}},
            ],
          },
        }),
      ),
    ]);
    if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
    const snap = buildExpectedSchema(result.root, { dialect: "postgres" });
    const docs = snap.tables.find((t) => t.name === "docs")!;

    const revision = docs.columns.find((c) => c.name === "revision")!;
    expect(revision.nullable).toBe(true);
    expect(revision.default).toBeUndefined();

    const approver = docs.columns.find((c) => c.name === "approver")!;
    expect(approver.nullable).toBe(true);
    expect(approver.default).toBeUndefined();

    // The BASE's own column is unaffected: every row has it, so its default stands.
    const title = docs.columns.find((c) => c.name === "title")!;
    expect(title.nullable).toBe(false);
    expect(title.default).toEqual({ kind: "literal", value: "untitled" });
  });

  test("base-owned required column keeps its NOT NULL", async () => {
    const snap = buildExpectedSchema(await loadTph(), { dialect: "postgres" });
    const auths = snap.tables.find((t) => t.name === "auths")!;
    const reference = auths.columns.find((c) => c.name === "reference")!;
    expect(reference.nullable).toBe(false);
  });
});

// FK targeting a TPH SUBTYPE. A subtype has no table of its own — it lives in its
// discriminator base's — so every FK onto it must land on the BASE table. Pass 1
// skipped subtypes before registering them as FK targets, so `resolveTargetTable`
// returned undefined and `buildForeignKeys` dropped the constraint without a word.
// `meta verify --db` diffs against this same builder, so the drop was invisible to
// the drift gate too: expected and actual agreed because both lacked the FK.
async function loadTphReferenceTarget() {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            { "object.entity": { name: "Depot", children: [
              { "source.rdb": { "@table": "depots" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ]}},
            { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
              { "source.rdb": { "@table": "parties" } },
              { "field.long": { name: "id" } },
              { "field.enum": { name: "partyType", "@values": ["Carrier", "Broker"] } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ]}},
            // An ABSTRACT intermediate level: its field and reference belong to `parties`
            // just as much as a concrete subtype's own do.
            { "object.entity": { name: "Organization", extends: "Party", abstract: true, children: [
              { "field.long": { name: "hqDepotId" } },
              { "identity.reference": { name: "fkHqDepot", "@fields": "hqDepotId", "@references": "Depot" } },
            ]}},
            // A subtype declaring its OWN reference: the FK column folds into `parties`,
            // so the constraint must come with it.
            { "object.entity": { name: "Carrier", extends: "Organization", "@discriminatorValue": "Carrier", children: [
              { "field.long": { name: "homeDepotId" } },
              { "identity.reference": { name: "fkHomeDepot", "@fields": "homeDepotId", "@references": "Depot" } },
            ]}},
            // A second subtype declaring the SAME reference: one folded column, so one constraint.
            { "object.entity": { name: "Broker", extends: "Party", "@discriminatorValue": "Broker", children: [
              { "field.string": { name: "mcNumber", "@maxLength": 20 } },
              { "field.long": { name: "homeDepotId" } },
              { "identity.reference": { name: "fkHomeDepot", "@fields": "homeDepotId", "@references": "Depot" } },
            ]}},
            { "object.entity": { name: "Shipment", children: [
              { "source.rdb": { "@table": "shipments" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
              { "relationship.association": { name: "carriers", "@cardinality": "many", "@objectRef": "Carrier", "@through": "Leg" } },
            ]}},
            { "object.entity": { name: "Leg", children: [
              { "source.rdb": { "@table": "legs" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "shipmentId", "@required": true } },
              { "field.long": { name: "carrierId", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
              { "identity.reference": { name: "fkShipment", "@fields": "shipmentId", "@references": "Shipment" } },
              { "identity.reference": { name: "fkCarrier", "@fields": "carrierId", "@references": "Carrier" } },
            ]}},
            // A reference onto the ABSTRACT level: its rows are in `parties` too.
            { "object.entity": { name: "Contract", children: [
              { "source.rdb": { "@table": "contracts" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "organizationId", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
              { "identity.reference": { name: "fkOrganization", "@fields": "organizationId", "@references": "Organization" } },
            ]}},
            // Self-join junction onto the subtype; one side is package-qualified so the
            // FQN lookup is exercised as well as the bare one.
            { "object.entity": { name: "CarrierPartnership", children: [
              { "source.rdb": { "@table": "carrier_partnerships" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "fromCarrierId", "@required": true } },
              { "field.long": { name: "toCarrierId", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
              { "identity.reference": { name: "fkFromCarrier", "@fields": "fromCarrierId", "@references": "Carrier" } },
              { "identity.reference": { name: "fkToCarrier", "@fields": "toCarrierId", "@references": "demo::Carrier" } },
            ]}},
          ],
        },
      }),
    ),
  ]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.root;
}

describe("buildExpectedSchema — FK targeting a TPH subtype", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: an FK onto a subtype references the discriminator base's table`, async () => {
      const snap = buildExpectedSchema(await loadTphReferenceTarget(), { dialect });
      const legs = snap.tables.find((t) => t.name === "legs")!;
      const byCol = new Map(legs.foreignKeys.map((fk) => [fk.columns.join(","), fk]));
      expect(byCol.get("shipment_id")?.refTable).toBe("shipments");
      expect(byCol.get("carrier_id")).toEqual({
        name: "legs_carrier_id_fk",
        columns: ["carrier_id"],
        refTable: "parties",
        refColumns: ["id"],
      });
    });

    test(`${dialect}: both sides of a self-join junction onto a subtype, bare and qualified`, async () => {
      const snap = buildExpectedSchema(await loadTphReferenceTarget(), { dialect });
      const junction = snap.tables.find((t) => t.name === "carrier_partnerships")!;
      expect(
        junction.foreignKeys.map((fk) => [fk.columns.join(","), fk.refTable, fk.refColumns.join(",")]).sort(),
      ).toEqual([
        ["from_carrier_id", "parties", "id"],
        ["to_carrier_id", "parties", "id"],
      ]);
    });

    test(`${dialect}: references declared ON a subtype keep their FKs on the base table`, async () => {
      const snap = buildExpectedSchema(await loadTphReferenceTarget(), { dialect });
      const parties = snap.tables.find((t) => t.name === "parties")!;
      expect(parties.columns.map((c) => c.name).sort()).toEqual(
        ["home_depot_id", "hq_depot_id", "id", "mc_number", "party_type"],
      );
      // One constraint per folded column, however many subtypes declare it.
      expect(parties.foreignKeys.map((fk) => [fk.columns.join(","), fk.refTable]).sort()).toEqual([
        ["home_depot_id", "depots"],
        ["hq_depot_id", "depots"],
      ]);
    });

    test(`${dialect}: an FK onto an abstract level references the discriminator base's table`, async () => {
      const snap = buildExpectedSchema(await loadTphReferenceTarget(), { dialect });
      const contracts = snap.tables.find((t) => t.name === "contracts")!;
      expect(contracts.foreignKeys.map((fk) => [fk.columns.join(","), fk.refTable, fk.refColumns.join(",")])).toEqual([
        ["organization_id", "parties", "id"],
      ]);
    });

    test(`${dialect}: a subtype still emits no table of its own`, async () => {
      const snap = buildExpectedSchema(await loadTphReferenceTarget(), { dialect });
      expect(snap.tables.map((t) => t.name).sort()).toEqual(
        ["carrier_partnerships", "contracts", "depots", "legs", "parties", "shipments"],
      );
    });
  }
});
