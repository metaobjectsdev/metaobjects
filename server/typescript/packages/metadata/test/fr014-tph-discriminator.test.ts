// FR-014 — TPH (Table-per-Hierarchy) discriminator metadata.
// Loader-level tests: constants exported, attr-schema accepts the new attrs,
// and the 4 cross-attribute validation rules fire.

import { describe, expect, test } from "bun:test";
import {
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "../src/core/object/object-constants.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ERROR_CODES } from "../src/errors.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

describe("FR-014 constants + error codes", () => {
  test("OBJECT_ATTR_DISCRIMINATOR exported as 'discriminator'", () => {
    expect(OBJECT_ATTR_DISCRIMINATOR).toBe("discriminator");
  });
  test("OBJECT_ATTR_DISCRIMINATOR_VALUE exported as 'discriminatorValue'", () => {
    expect(OBJECT_ATTR_DISCRIMINATOR_VALUE).toBe("discriminatorValue");
  });
  test("ERR_DISCRIMINATOR_FIELD_NOT_FOUND registered", () => {
    expect(ERROR_CODES).toContain("ERR_DISCRIMINATOR_FIELD_NOT_FOUND");
  });
  test("ERR_DISCRIMINATOR_VALUE_DUPLICATE registered", () => {
    expect(ERROR_CODES).toContain("ERR_DISCRIMINATOR_VALUE_DUPLICATE");
  });
  test("ERR_DISCRIMINATOR_VALUE_MISSING registered", () => {
    expect(ERROR_CODES).toContain("ERR_DISCRIMINATOR_VALUE_MISSING");
  });
  test("ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH registered", () => {
    expect(ERROR_CODES).toContain("ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH");
  });
});

describe("FR-014 happy paths", () => {
  test("base entity with @discriminator + 2 subtypes loads cleanly", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                {
                  "field.enum": {
                    name: "type",
                    "@values": ["Bridge", "Copay"],
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "BridgeAuth",
              extends: "Auth",
              "@discriminatorValue": "Bridge",
              children: [{ "field.int": { name: "quantity" } }],
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
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("base entity with @discriminator + NO subtypes is permitted (refactor-in-progress)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                { "field.string": { name: "type" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("inherited discriminator field via extends chain resolves", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "BaseAuth",
              abstract: true,
              "@discriminator": "type",
              children: [
                { "field.string": { name: "type" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "ConcreteAuth",
              extends: "BaseAuth",
              "@discriminatorValue": "Concrete",
              children: [
                { "source.rdb": { "@table": "concrete_auths" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("FR-014 ERR_DISCRIMINATOR_FIELD_NOT_FOUND", () => {
  test("@discriminator names a non-existent field", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "noSuchField",
              children: [
                { "source.rdb": { "@table": "auths" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_DISCRIMINATOR_FIELD_NOT_FOUND");
  });
});

describe("FR-014 ERR_DISCRIMINATOR_VALUE_DUPLICATE", () => {
  test("two subtypes claim the same @discriminatorValue", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                {
                  "field.enum": {
                    name: "type",
                    "@values": ["Bridge", "Copay"],
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "BridgeA",
              extends: "Auth",
              "@discriminatorValue": "Bridge",
              children: [],
            },
          },
          {
            "object.entity": {
              name: "BridgeB",
              extends: "Auth",
              "@discriminatorValue": "Bridge",
              children: [],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_DISCRIMINATOR_VALUE_DUPLICATE");
  });
});

describe("FR-014 ERR_DISCRIMINATOR_VALUE_MISSING", () => {
  test("concrete subtype of a @discriminator-bearing root lacks @discriminatorValue", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                {
                  "field.enum": {
                    name: "type",
                    "@values": ["Bridge"],
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "ForgotValue",
              extends: "Auth",
              children: [{ "field.int": { name: "q" } }],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_DISCRIMINATOR_VALUE_MISSING");
  });

  test("abstract subtype may omit @discriminatorValue (it's just a mid-tree base)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                { "field.string": { name: "type" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "MidBase",
              extends: "Auth",
              abstract: true,
              children: [],
            },
          },
          {
            "object.entity": {
              name: "Leaf",
              extends: "MidBase",
              "@discriminatorValue": "L",
              children: [],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .not.toContain("ERR_DISCRIMINATOR_VALUE_MISSING");
  });
});

describe("FR-014 ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH", () => {
  test("@discriminatorValue not a member of the enum field's @values", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                {
                  "field.enum": {
                    name: "type",
                    "@values": ["Bridge", "Copay"],
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Unknown",
              extends: "Auth",
              "@discriminatorValue": "NotInEnum",
              children: [],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH");
  });

  test("string-typed discriminator accepts any string value", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Auth",
              "@discriminator": "type",
              children: [
                { "source.rdb": { "@table": "auths" } },
                { "field.string": { name: "type" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Anything",
              extends: "Auth",
              "@discriminatorValue": "arbitrary",
              children: [],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .not.toContain("ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH");
  });
});
