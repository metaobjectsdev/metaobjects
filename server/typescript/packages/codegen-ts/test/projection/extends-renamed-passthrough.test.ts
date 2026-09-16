import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";

/**
 * A projection field may RENAME what it exposes:
 *
 *   { field.string: { name: bookingRef, extends: "Shipment.reference" } }
 *
 * The view's OUTPUT column is the projection field's (`booking_ref`); the column it
 * SELECTS is the extends TARGET's (`reference`). Deriving both from the projection
 * field emits `SELECT s.booking_ref` against a table whose column is `reference` —
 * a view SQLite accepts at CREATE and fails at first SELECT, Postgres rejects outright.
 *
 * Renaming base columns is one of only two things the authoring guidance says
 * genuinely forces a projection, so this is the construct's headline case.
 */
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

const shipment = {
  "object.entity": {
    name: "Shipment",
    children: [
      { "source.rdb": { "@table": "shipment" } },
      { "field.int": { name: "id" } },
      { "field.string": { name: "reference" } },
      { "field.string": { name: "originCity" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ],
  },
};

describe("extractViewSpec — extends-bound passthrough that RENAMES the base field", () => {
  test("sourceColumn comes from the extends target, dbColAlias from the projection field", async () => {
    const root = await load([
      shipment,
      {
        "object.projection": {
          name: "ShipmentSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_shipment_summary" } },
            { "field.int": { name: "id", extends: "Shipment.id" } },
            // THE RENAME: exposed as bookingRef, sourced from Shipment.reference.
            { "field.string": { name: "bookingRef", extends: "Shipment.reference" } },
            { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ShipmentSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    const booking = spec.selectSpec.columns.find((c) => c.fieldName === "bookingRef")!;
    expect(booking.kind).toBe("passthrough");
    if (booking.kind === "passthrough") {
      // The view exposes it under the projection's own name…
      expect(booking.dbColAlias).toBe("booking_ref");
      // …but SELECTs the base entity's real column.
      expect(booking.sourceColumn).toBe("reference");
    }

    // An un-renamed field is unaffected.
    const id = spec.selectSpec.columns.find((c) => c.fieldName === "id")!;
    if (id.kind === "passthrough") {
      expect(id.dbColAlias).toBe("id");
      expect(id.sourceColumn).toBe("id");
    }
  });

  test("an explicit @column on the projection field names the VIEW column, not the base's", async () => {
    const root = await load([
      shipment,
      {
        "object.projection": {
          name: "ShipmentSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_shipment_summary" } },
            { "field.int": { name: "id", extends: "Shipment.id" } },
            {
              "field.string": {
                name: "bookingRef",
                extends: "Shipment.reference",
                "@column": "booking_code",
              },
            },
            { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ShipmentSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const booking = spec.selectSpec.columns.find((c) => c.fieldName === "bookingRef")!;
    if (booking.kind === "passthrough") {
      expect(booking.dbColAlias).toBe("booking_code");
      expect(booking.sourceColumn).toBe("reference");
    }
  });

  test("a field-level extends onto an ABSTRACT (shape reuse) does not hijack the source column", async () => {
    const root = await load([
      // A package-level abstract field reused for its shape, NOT a base column.
      { "field.string": { name: "Code24", abstract: true, "@maxLength": 24 } },
      {
        "object.entity": {
          name: "Shipment",
          children: [
            { "source.rdb": { "@table": "shipment" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "reference" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ShipmentSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_shipment_summary" } },
            { "field.int": { name: "id", extends: "Shipment.id" } },
            // Extends an abstract for SHAPE — the base column is its own name.
            { "field.string": { name: "reference", extends: "Code24" } },
            { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ShipmentSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const ref = spec.selectSpec.columns.find((c) => c.fieldName === "reference")!;
    if (ref.kind === "passthrough") {
      expect(ref.dbColAlias).toBe("reference");
      // NOT "code24" — the abstract is shape, not a base column.
      expect(ref.sourceColumn).toBe("reference");
    }
  });

  test("end to end: the emitted CREATE VIEW selects the base column under the new alias", async () => {
    const root = await load([
      shipment,
      {
        "object.projection": {
          name: "ShipmentSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_shipment_summary" } },
            { "field.int": { name: "id", extends: "Shipment.id" } },
            { "field.string": { name: "bookingRef", extends: "Shipment.reference" } },
            { "field.string": { name: "originCity", extends: "Shipment.originCity" } },
            { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ShipmentSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const sql = emitViewDdl(spec, {
      dialect: "sqlite",
      baseTableName: "shipment",
      joinTables: {},
    });

    // The rename is an ALIAS over the base column, not a second column name.
    expect(sql).toContain("s.reference AS booking_ref");
    // And never the pre-fix form, which named a column `shipment` does not have.
    expect(sql).not.toContain("s.booking_ref");
    expect(sql).toContain("s.origin_city AS origin_city");
  });
});

describe("read-view HOST — the rename rule must NOT apply", () => {
  /**
   * A write-through entity's read-view reads its OWN table, so a passthrough always sources
   * from the field's own column. A host field may legally `extends` a SIBLING field of the
   * same entity for shape reuse — a dotted ref whose owner IS the base. Treating that as a
   * rename makes the view serve the sibling's data under this field's name: valid SQL, no
   * error, wrong rows.
   */
  test("a host field extending a SIBLING field still selects its own column", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Shipment",
          children: [
            { "source.rdb": { "@kind": "table", "@table": "shipment", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "v_shipment", "@role": "replica" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "reference" } },
            // Shape reuse off a sibling — NOT a rename of it.
            { "field.string": { name: "altReference", extends: "Shipment.reference" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ],
        },
      },
    ]);

    const host = root.objects().find((o) => o.name === "Shipment")!;
    const spec = extractViewSpec(host, root, { columnNamingStrategy: "snake_case" });

    const alt = spec.selectSpec.columns.find((c) => c.fieldName === "altReference")!;
    expect(alt.kind).toBe("passthrough");
    if (alt.kind === "passthrough") {
      expect(alt.dbColAlias).toBe("alt_reference");
      // Its OWN column — not the sibling's, which is a real separate column on the table.
      expect(alt.sourceColumn).toBe("alt_reference");
    }

    const sql = emitViewDdl(spec, {
      dialect: "sqlite",
      baseTableName: "shipment",
      joinTables: {},
    });
    expect(sql).toContain("s.alt_reference AS alt_reference");
    expect(sql).toContain("s.reference AS reference");
  });
});
