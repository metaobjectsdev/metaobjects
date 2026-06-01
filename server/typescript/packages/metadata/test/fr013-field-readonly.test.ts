// FR-013 — field-level @readOnly attribute. Tests the metamodel surface:
// constant export, schema registration, validation passes (ERR_READONLY_DOWNGRADE,
// ERR_READONLY_ASSIGNED_PRIMARY, WARN_READONLY_VALUE_OBJECT), and the
// MetaField.readOnly accessor that codegen / runtime consume.

import { describe, expect, test } from "bun:test";
import { FIELD_ATTR_READ_ONLY } from "../src/core/field/field-constants.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ERROR_CODES, WARNING_CODES } from "../src/errors.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

describe("FR-013 constants + error/warning code registration", () => {
  test("FIELD_ATTR_READ_ONLY exported as 'readOnly'", () => {
    expect(FIELD_ATTR_READ_ONLY).toBe("readOnly");
  });

  test("ERR_READONLY_DOWNGRADE registered in ERROR_CODES", () => {
    expect(ERROR_CODES).toContain("ERR_READONLY_DOWNGRADE");
  });

  test("ERR_READONLY_ASSIGNED_PRIMARY registered in ERROR_CODES", () => {
    expect(ERROR_CODES).toContain("ERR_READONLY_ASSIGNED_PRIMARY");
  });

  test("WARN_READONLY_VALUE_OBJECT registered in WARNING_CODES", () => {
    expect(WARNING_CODES).toContain("WARN_READONLY_VALUE_OBJECT");
  });
});

describe("FR-013 schema registration", () => {
  test("source.rdb writable entity accepts @readOnly: true on a field", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "source.rdb": { "@table": "customers" } },
                { "field.long": { name: "id" } },
                { "field.timestamp": { name: "created_at", "@readOnly": true } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("FR-013 ERR_READONLY_ASSIGNED_PRIMARY", () => {
  test("@readOnly: true on a field used as identity.primary with @generation: 'assigned' errors", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              children: [
                { "source.rdb": { "@table": "subscribers" } },
                { "field.string": { name: "id", "@readOnly": true } },
                {
                  "identity.primary": {
                    "@fields": "id",
                    "@generation": "assigned",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code: string }).code);
    expect(codes).toContain("ERR_READONLY_ASSIGNED_PRIMARY");
  });

  test("@readOnly: true on an identity.primary field with @generation: 'increment' is fine", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              children: [
                { "source.rdb": { "@table": "subscribers" } },
                { "field.long": { name: "id", "@readOnly": true } },
                {
                  "identity.primary": {
                    "@fields": "id",
                    "@generation": "increment",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as { code: string }).code))
      .not.toContain("ERR_READONLY_ASSIGNED_PRIMARY");
  });
});

describe("FR-013 ERR_READONLY_DOWNGRADE (extends inheritance)", () => {
  test("subtype declares @readOnly: false on an inherited @readOnly: true field → ERR_READONLY_DOWNGRADE", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "BaseEntity",
              abstract: true,
              children: [
                { "field.timestamp": { name: "createdAt", "@readOnly": true } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Subscriber",
              extends: "BaseEntity",
              children: [
                { "source.rdb": { "@table": "subscribers" } },
                { "field.long": { name: "id" } },
                { "field.timestamp": { name: "createdAt", "@readOnly": false } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code: string }).code);
    expect(codes).toContain("ERR_READONLY_DOWNGRADE");
  });

  test("subtype upgrades writable inherited field to @readOnly: true is fine", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "BaseEntity",
              abstract: true,
              children: [
                { "field.string": { name: "label" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Customer",
              extends: "BaseEntity",
              children: [
                { "source.rdb": { "@table": "customers" } },
                { "field.long": { name: "id" } },
                { "field.string": { name: "label", "@readOnly": true } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as { code: string }).code))
      .not.toContain("ERR_READONLY_DOWNGRADE");
  });
});

describe("FR-013 WARN_READONLY_VALUE_OBJECT", () => {
  test("@readOnly: true on a field child of object.value emits a warning", async () => {
    const { warnings } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "Money",
              children: [
                { "field.long": { name: "amountCents", "@readOnly": true } },
                { "field.string": { name: "currency" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Item",
              children: [
                { "source.rdb": { "@table": "items" } },
                { "field.long": { name: "id" } },
                {
                  "field.object": {
                    name: "price",
                    "@objectRef": "Money",
                    "@storage": "flattened",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(warnings.map((w) => w.code)).toContain("WARN_READONLY_VALUE_OBJECT");
  });
});
