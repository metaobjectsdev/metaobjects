import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { assertNoCollectionNameCollisions, ERR_COLLECTION_NAME_COLLISION } from "../../src/naming/collection-name-collision.js";

async function loadObjects(children: unknown[]): Promise<MetaObject[]> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root.objects();
}

function entity(name: string, extraChildren: unknown[] = []) {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": { "@table": name.toLowerCase() } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": "id" } },
        ...extraChildren,
      ],
    },
  };
}

function value(name: string) {
  return { "object.value": { name, children: [{ "field.string": { name: "text" } }] } };
}

describe("assertNoCollectionNameCollisions", () => {
  test("does not throw for a set of entities with distinct plurals", async () => {
    const objects = await loadObjects([entity("Post"), entity("Author"), entity("Category")]);
    expect(() => assertNoCollectionNameCollisions(objects)).not.toThrow();
  });

  test("throws when an already-plural entity collides with its singular counterpart", async () => {
    // "Address" legacy-pluralizes to "Addresses"; "Addresses" is
    // already-plural and stays "Addresses" — both land on the same collection name.
    const objects = await loadObjects([entity("Address"), entity("Addresses")]);
    expect(() => assertNoCollectionNameCollisions(objects)).toThrow(
      new RegExp(`${ERR_COLLECTION_NAME_COLLISION}.*"Address".*"Addresses".*"Addresses"`),
    );
  });

  test("throws for an Order / Orders pair the same way", async () => {
    const objects = await loadObjects([entity("Order"), entity("Orders")]);
    expect(() => assertNoCollectionNameCollisions(objects)).toThrow(ERR_COLLECTION_NAME_COLLISION);
  });

  test("a single entity whose name is already plural does not throw against itself", async () => {
    const objects = await loadObjects([entity("ProgramPurchaseStats")]);
    expect(() => assertNoCollectionNameCollisions(objects)).not.toThrow();
  });

  test("object.value is excluded — a value object never gets a route/hook/collection name", async () => {
    // "Address" (entity) legacy-pluralizes to "Addresses"; an UNRELATED object.value
    // also named "Addresses" would — if value objects were included — collide on
    // paper, but a value object emits no route/hook/DbSet, so it must not trip this.
    const objects = await loadObjects([entity("Address"), value("Addresses")]);
    expect(() => assertNoCollectionNameCollisions(objects)).not.toThrow();
  });

  test("a TPH subtype's own plural can collide with an unrelated top-level entity", async () => {
    const objects = await loadObjects([
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "type",
          children: [
            { "source.rdb": { "@table": "auth" } },
            { "field.enum": { name: "type", "@values": ["Address"] } },
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Address",
          extends: "Auth",
          "@discriminatorValue": "Address",
          children: [],
        },
      },
      entity("Addresses"),
    ]);
    expect(() => assertNoCollectionNameCollisions(objects)).toThrow(ERR_COLLECTION_NAME_COLLISION);
  });

  test("fixtures/naming-conformance/'s collisionCases are all refused", async () => {
    const fixturePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "..", "..", "..",
      "fixtures", "naming-conformance", "already-plural-pluralize.json",
    );
    const { collisionCases } = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      collisionCases: { entityA: string; entityB: string }[];
    };
    for (const { entityA, entityB } of collisionCases) {
      const objects = await loadObjects([entity(entityA), entity(entityB)]);
      expect(() => assertNoCollectionNameCollisions(objects)).toThrow(ERR_COLLECTION_NAME_COLLISION);
    }
  });
});
