/**
 * Guard: a foreign key must reference columns the target table holds unique.
 *
 * A reference whose dotted @references names target fields other than the target's
 * primary key, with nothing declaring those fields unique, used to pass load and emit
 * an FK Postgres refuses at apply time ("there is no unique constraint matching given
 * keys for referenced table"). buildExpectedSchema() must refuse it before any SQL is
 * emitted, naming the reference and the fix.
 *
 * Unique means: exactly the primary key's fields, exactly the fields of an
 * identity.secondary that is a plain unique key (no @where, no @expr), or a single
 * field carrying @unique. Field order does not matter; a subset or superset does.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { FkTargetNotUniqueError } from "../../src/errors.js";
import { buildExpectedSchemaWithProvenance } from "../../src/expected-schema.js";
import { scopeExpectedSchema } from "../../src/scope.js";
import { emit } from "../../src/emit/index.js";
import { diff } from "../../src/diff/index.js";
import { Database } from "bun:sqlite";

async function loadDoc(doc: unknown) {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc)),
  ]);
  expect(errors).toHaveLength(0);
  return root;
}

/** A target entity (Person: id, region, code) and a holder (Visit) referencing it. */
function makeDoc(options: {
  references: string;
  holderFields: string[];
  targetExtra?: unknown[];
  codeUnique?: boolean;
}) {
  return {
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Person",
            children: [
              { "source.rdb": {} },
              { "field.long": { name: "id" } },
              { "field.long": { name: "region" } },
              { "field.string": { name: "code", ...(options.codeUnique ? { "@unique": true } : {}) } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              ...(options.targetExtra ?? []),
            ],
          },
        },
        {
          "object.entity": {
            name: "Visit",
            children: [
              { "source.rdb": {} },
              { "field.long": { name: "id" } },
              { "field.long": { name: "personId" } },
              { "field.long": { name: "personRegion" } },
              { "field.string": { name: "personCode" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              {
                "identity.reference": {
                  name: "ref_person",
                  "@fields": options.holderFields,
                  "@references": options.references,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

async function build(options: Parameters<typeof makeDoc>[0]) {
  const root = await loadDoc(makeDoc(options));
  return () => buildExpectedSchema(root);
}

describe("buildExpectedSchema — an FK must reference a unique key", () => {
  test("a non-key target field with nothing unique on it → FkTargetNotUniqueError naming the fix", async () => {
    const run = await build({ references: "Person.code", holderFields: ["personCode"] });

    expect(run).toThrow(FkTargetNotUniqueError);
    expect(run).toThrow(/Entity "Visit": reference "ref_person" targets \[code\] on "Person"/);
    expect(run).toThrow(/identity\.secondary/);
  });

  test("every offending reference, across tables, in ONE error — not one per run", async () => {
    const doc = makeDoc({ references: "Person.code", holderFields: ["personCode"] });
    const children = (doc["metadata.root"] as { children: unknown[] }).children;
    children.push({
      "object.entity": {
        name: "Badge",
        children: [
          { "source.rdb": {} },
          { "field.long": { name: "id" } },
          { "field.long": { name: "ownerRegion" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_owner", "@fields": ["ownerRegion"], "@references": "Person.region" } },
        ],
      },
    });
    const root = await loadDoc(doc);

    let caught: unknown;
    try { buildExpectedSchema(root); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(FkTargetNotUniqueError);
    const err = caught as FkTargetNotUniqueError;
    expect(err.violations.map((v) => `${v.entityName}.${v.referenceName}`).sort()).toEqual(["Badge.ref_owner", "Visit.ref_person"]);
    expect(err.message).toContain('reference "ref_person" targets [code] on "Person"');
    expect(err.message).toContain('reference "ref_owner" targets [region] on "Person"');
  });

  test("a composite target that is not a declared key → throws", async () => {
    const run = await build({ references: "Person.id,region", holderFields: ["personId", "personRegion"] });

    expect(run).toThrow(FkTargetNotUniqueError);
  });

  test("a partial unique index is not a key an FK can reference → throws", async () => {
    const run = await build({
      references: "Person.code",
      holderFields: ["personCode"],
      targetExtra: [{ "identity.secondary": { name: "ux_person_code", "@fields": ["code"], "@where": "\"region\" = 1" } }],
    });

    expect(run).toThrow(FkTargetNotUniqueError);
  });

  test("an identity.secondary on exactly the target fields, in any order → no throw", async () => {
    const run = await build({
      references: "Person.id,region",
      holderFields: ["personId", "personRegion"],
      targetExtra: [{ "identity.secondary": { name: "ak_person_region_id", "@fields": ["region", "id"] } }],
    });

    expect(run).not.toThrow();
  });

  test("a single target field with @unique → no throw", async () => {
    const run = await build({ references: "Person.code", holderFields: ["personCode"], codeUnique: true });

    expect(run).not.toThrow();
  });

  test("the target's primary key, bare or dotted → no throw", async () => {
    expect(await build({ references: "Person", holderFields: ["personId"] })).not.toThrow();
    expect(await build({ references: "Person.id", holderFields: ["personId"] })).not.toThrow();
  });

  test("a TPH subtype's unique key is not emitted, so it does not count — the hint names the base", async () => {
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Party", "@discriminator": "kind", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "kind", "@values": ["Carrier", "Broker"] } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Carrier", extends: "Party", "@discriminatorValue": "Carrier", children: [
        { "field.string": { name: "code" } },
        { "identity.secondary": { name: "ux_carrier_code", "@fields": ["code"] } },
      ] } },
      { "object.entity": { name: "Policy", children: [
        { "source.rdb": { "@table": "policies" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "carrierCode" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "ref_carrier", "@fields": ["carrierCode"], "@references": "Carrier.code" } },
      ] } },
    ] } };
    const root = await loadDoc(doc);

    expect(() => buildExpectedSchema(root)).toThrow(FkTargetNotUniqueError);
    expect(() => buildExpectedSchema(root)).toThrow(/stored in the table of "Party".*declare it on "Party"/);
  });

  test("a bare reference into a composite primary key with one FK field is refused", async () => {
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Line", children: [
        { "source.rdb": {} },
        { "field.long": { name: "orderId" } },
        { "field.int": { name: "lineNo" } },
        { "identity.primary": { name: "pk", "@fields": ["orderId", "lineNo"] } },
      ] } },
      { "object.entity": { name: "Note", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.long": { name: "lineOrderId" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "ref_line", "@fields": ["lineOrderId"], "@references": "Line" } },
      ] } },
    ] } };

    const root = await loadDoc(doc);

    expect(() => buildExpectedSchema(root)).toThrow(FkTargetNotUniqueError);
    expect(() => buildExpectedSchema(root)).toThrow(/reference "ref_line" targets \[orderId\] on "Line"/);
  });

  test("a target this model does not build (@unmanaged) is not refused: its keys are not known here", async () => {
    const doc = makeDoc({ references: "Person.code", holderFields: ["personCode"] });
    const person = (doc["metadata.root"].children[0] as { "object.entity": { children: unknown[] } })["object.entity"];
    person.children[0] = { "source.rdb": { "@unmanaged": true } };
    const root = await loadDoc(doc);

    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("through scopeExpectedSchema only a governed holder is refused; the others are returned", async () => {
    const root = await loadDoc(makeDoc({ references: "Person.code", holderFields: ["personCode"] }));
    const built = buildExpectedSchemaWithProvenance(root);

    expect(built.fkTargetViolations?.map((v) => v.referenceName)).toEqual(["ref_person"]);
    expect(() => scopeExpectedSchema(built, undefined)).toThrow(FkTargetNotUniqueError);
    const outside = scopeExpectedSchema(built, (fqn) => !fqn.endsWith("Visit"));
    expect(outside.ungovernedFkTargetViolations?.map((v) => v.referenceName)).toEqual(["ref_person"]);
  });
});

describe("on SQLite an FK onto a non-unique target is reported, not refused", () => {
  // SQLite checks foreign keys only with PRAGMA foreign_keys on (off by default), so the
  // DDL is accepted and only an enforced write fails. D1 always enforces them, and Postgres
  // refuses the DDL itself, so both keep the refusal.
  test("buildExpectedSchema on SQLite does not throw; on Postgres and D1 it does", async () => {
    const root = await loadDoc(makeDoc({ references: "Person.code", holderFields: ["personCode"] }));
    expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).not.toThrow();
    expect(() => buildExpectedSchema(root, { dialect: "d1" })).toThrow(FkTargetNotUniqueError);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(FkTargetNotUniqueError);
  });

  test("scopeExpectedSchema returns them as unenforced, governed or not", async () => {
    const root = await loadDoc(makeDoc({ references: "Person.code", holderFields: ["personCode"] }));
    const scoped = scopeExpectedSchema(buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" }), undefined);
    expect(scoped.unenforcedFkTargetViolations?.map((v) => v.referenceName)).toEqual(["ref_person"]);
    expect(scoped.ungovernedFkTargetViolations).toBeUndefined();
  });

  test("the SQLite DDL applies; a write fails only once foreign keys are enforced", async () => {
    const root = await loadDoc(makeDoc({ references: "Person.code", holderFields: ["personCode"] }));
    const want = buildExpectedSchema(root, { dialect: "sqlite" });
    const { changes } = await diff(want, { tables: [], views: [] }, { dialect: "sqlite" });
    const { up } = emit(changes, { dialect: "sqlite" });
    const db = new Database(":memory:");
    try {
      db.exec(up);
      const person = want.tables.find((t) => t.name !== "visit" && t.columns.some((c) => c.name === "code"))!;
      const visit = want.tables.find((t) => t !== person)!;
      const col = (t: typeof person, n: string) => t.columns.find((c) => c.name.replace(/_/g, "").toLowerCase() === n.toLowerCase())!.name;
      db.exec(`INSERT INTO "${person.name}" ("${col(person, "id")}", "${col(person, "region")}", "${col(person, "code")}") VALUES (1, 1, 'a')`);
      const insertVisit = `INSERT INTO "${visit.name}" ("${col(visit, "id")}", "${col(visit, "personId")}", "${col(visit, "personRegion")}", "${col(visit, "personCode")}") VALUES (1, 1, 1, 'a')`;
      db.exec(insertVisit);
      db.exec("PRAGMA foreign_keys = ON");
      expect(() => db.exec(insertVisit.replace("VALUES (1,", "VALUES (2,"))).toThrow(/foreign key mismatch/);
    } finally {
      db.close();
    }
  });
});
