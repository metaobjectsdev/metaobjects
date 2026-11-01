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
});
