// #248 — buildExpectedSchema Pass 1 must derive table persistability from a
// declared/inherited WRITABLE source (metadata's own loader contract: zero
// sources ⇒ not persisted), never from `subType`. Before this fix, ANY object
// with no `source.*` — a plain sourceless entity, or an object of a custom
// provider-registered subtype — fell through the `subType === "value"` compare
// and got a phantom `TableDescriptor` (fabricated physical name, entered the FK-
// target maps). See docs/superpowers/specs/2026-08-01-issue-248-persistability-
// from-source-design.md §3/§3a for the derivation.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  composeRegistry,
  coreProviders,
  MetaObject,
  TypeId,
  TYPE_OBJECT,
  TYPE_FIELD,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaDataTypeProvider, TypeRegistry } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadJson(json: unknown, registry?: TypeRegistry): Promise<MetaData> {
  const result = await new MetaDataLoader(registry !== undefined ? { registry } : undefined).load([
    new InMemoryStringSource(JSON.stringify(json)),
  ]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

describe("buildExpectedSchema — persistability derives from source presence (#248)", () => {
  test("1. sourceless entity co-load: only the sourced entity gets a table", async () => {
    const root = await loadJson({
      "metadata.root": {
        package: "acme::probe",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "ref" } },
                { "source.rdb": { "@table": "orders" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Ghost",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "note" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });

    const snapshot = buildExpectedSchema(root);
    expect(snapshot.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  test("2. no fabricated FK target: a reference to a sourceless object yields no FkDescriptor", async () => {
    const root = await loadJson({
      "metadata.root": {
        package: "acme::probe",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "ref" } },
                { "field.long": { name: "ghostId" } },
                { "source.rdb": { "@table": "orders" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
                {
                  "identity.reference": {
                    name: "ref_ghost",
                    "@fields": ["ghostId"],
                    "@references": "Ghost",
                  },
                },
              ],
            },
          },
          {
            "object.entity": {
              name: "Ghost",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "note" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });

    expect(() => {
      const snapshot = buildExpectedSchema(root);
      const orders = snapshot.tables.find((t) => t.name === "orders");
      expect(orders?.foreignKeys.length).toBe(0);
    }).not.toThrow();
  });

  test("3. custom subtype (the reported scenario): a sourceless object.message gets no table", async () => {
    const wireProvider: MetaDataTypeProvider = {
      id: "test-wire-messages",
      dependencies: ["metaobjects-core-types"],
      registerTypes(registry: TypeRegistry): void {
        registry.register({
          typeId: new TypeId(TYPE_OBJECT, "message"),
          description: "Test-only wire message subtype — no source, never persisted.",
          factory: (typeId, name) => new MetaObject(typeId, name),
          childRules: [{ childType: TYPE_FIELD, childSubType: "*", childName: "*" }],
          attributes: [],
        });
      },
    };
    const registry = composeRegistry([...coreProviders, wireProvider]);

    const root = await loadJson(
      {
        "metadata.root": {
          package: "acme::probe",
          children: [
            {
              "object.entity": {
                name: "Order",
                children: [
                  { "field.long": { name: "id" } },
                  { "field.string": { name: "ref" } },
                  { "source.rdb": { "@table": "orders" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                ],
              },
            },
            {
              "object.message": {
                name: "WireNote",
                children: [
                  { "field.string": { name: "topic" } },
                  { "field.string": { name: "payload" } },
                ],
              },
            },
          ],
        },
      },
      registry,
    );

    const snapshot = buildExpectedSchema(root);
    expect(snapshot.tables.map((t) => t.name)).toEqual(["orders"]);
  });

  test("4. (pin) inherited writable source via extends still persists", async () => {
    const root = await loadJson({
      "metadata.root": {
        package: "acme::probe",
        children: [
          {
            "object.entity": {
              name: "Base",
              abstract: true,
              children: [
                { "field.long": { name: "id" } },
                { "source.rdb": { "@table": "things" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Thing",
              extends: "Base",
              children: [{ "field.string": { name: "label" } }],
            },
          },
        ],
      },
    });

    const snapshot = buildExpectedSchema(root);
    expect(snapshot.tables.map((t) => t.name)).toEqual(["things"]);
  });
});
