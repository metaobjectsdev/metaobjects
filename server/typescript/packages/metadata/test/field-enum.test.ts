// Unit tests for field.enum subtype — loading, attrs, and abstract extends inheritance.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_PROVIDED,
} from "../src/core/field/field-constants.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(JSON.stringify(doc))]);
}

// ---------------------------------------------------------------------------
// Happy-path: inline enum field
// ---------------------------------------------------------------------------

describe("field.enum — inline @values", () => {
  it("loads a field.enum with @values, subType is 'enum'", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);

    const entity = root.ownChildren().find((c) => c.name === "Order");
    expect(entity).toBeInstanceOf(MetaObject);
    const obj = entity as MetaObject;
    const field = obj.findField("status");
    expect(field).toBeInstanceOf(MetaField);
    expect(field!.subType).toBe(FIELD_SUBTYPE_ENUM);
    const values = field!.ownAttr(FIELD_ATTR_VALUES);
    expect(values).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });

  it("preserves declaration order of @values members", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Item",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "priority",
                    "@values": ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    const obj = root.ownChildren().find((c) => c.name === "Item") as MetaObject;
    const field = obj.findField("priority");
    expect(field!.ownAttr(FIELD_ATTR_VALUES)).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
  });
});

// ---------------------------------------------------------------------------
// Abstract field + extends: @values inheritance
// ---------------------------------------------------------------------------

describe("field.enum — abstract + extends inherits @values", () => {
  it("concrete field inherits @values from abstract super via attrs()", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "status", extends: "Status" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);

    const entity = root.ownChildren().find((c) => c.name === "Order");
    const obj = entity as MetaObject;
    const field = obj.findField("status");
    expect(field).toBeInstanceOf(MetaField);

    // Own attrs must NOT include @values (it's on the super, not the concrete field)
    expect(field!.ownAttr(FIELD_ATTR_VALUES)).toBeUndefined();

    // Effective attrs (own + inherited) MUST include @values
    const effective = field!.attrs();
    expect(effective.get(FIELD_ATTR_VALUES)).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });

  it("resolveSuper() returns the abstract Status field", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@values": ["ACTIVE", "INACTIVE"],
            },
          },
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "status", extends: "Status" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    const obj = (root.ownChildren().find((c) => c.name === "Account")) as MetaObject;
    const field = obj.findField("status") as MetaField;
    const sup = field.resolveSuper();
    expect(sup).toBeInstanceOf(MetaField);
    expect(sup!.name).toBe("Status");
    expect(sup!.ownAttr(FIELD_ATTR_VALUES)).toEqual(["ACTIVE", "INACTIVE"]);
  });
});

// ---------------------------------------------------------------------------
// FR-019: @provided on an abstract field.enum declaration
// ---------------------------------------------------------------------------

describe("field.enum — @provided flag (FR-019)", () => {
  it("@provided: true loads clean and round-trips through the canonical serializer", async () => {
    const doc = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@provided": true,
              "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "status", extends: "Status" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    };
    const { root, errors } = await load(doc);
    expect(errors).toHaveLength(0);

    const declaration = root.fields().find((f) => f.name === "Status");
    expect(declaration).toBeInstanceOf(MetaField);
    expect(declaration!.ownAttr(FIELD_ATTR_PROVIDED)).toBe(true);

    // Round-trip: the canonical serializer must preserve @provided as a boolean,
    // and a re-parse of the canonical JSON must serialize identically.
    const serialized = canonicalSerialize(root);
    expect(serialized).toContain('"@provided": true');
    const reparsed = await load(JSON.parse(serialized));
    expect(reparsed.errors).toHaveLength(0);
    expect(canonicalSerialize(reparsed.root)).toBe(serialized);
  });

  it("emits ERR_BAD_ATTR_VALUE for a non-boolean @provided value", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@provided": "yes",
              "@values": ["DRAFT", "PUBLISHED"],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });
});

// ---------------------------------------------------------------------------
// isArray: field.enum with isArray: true
// ---------------------------------------------------------------------------

describe("field.enum — isArray", () => {
  it("loads a field.enum with isArray: true and @values", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "tags",
                    isArray: true,
                    "@values": ["RED", "GREEN", "BLUE"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    const obj = root.ownChildren().find((c) => c.name === "Order") as MetaObject;
    const field = obj.findField("tags");
    expect(field!.isArray).toBe(true);
    expect(field!.ownAttr(FIELD_ATTR_VALUES)).toEqual(["RED", "GREEN", "BLUE"]);
  });
});

// ---------------------------------------------------------------------------
// Negative: missing @values
// ---------------------------------------------------------------------------

describe("field.enum — missing @values", () => {
  it("emits ERR_MISSING_REQUIRED_ATTR when @values is absent", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "status" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_MISSING_REQUIRED_ATTR");
  });
});

// ---------------------------------------------------------------------------
// Negative: @values content validation (identifier-safety + duplicates)
// ---------------------------------------------------------------------------

describe("field.enum — @values content validation", () => {
  it("emits ERR_BAD_ATTR_VALUE for a non-identifier-safe member (kebab-case)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    "@values": ["in-progress"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("emits ERR_BAD_ATTR_VALUE for a member with a leading digit", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "level",
                    "@values": ["1ST", "2ND"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("emits ERR_BAD_ATTR_VALUE for duplicate members", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    "@values": ["ACTIVE", "ACTIVE"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("does NOT emit an error for valid identifier-safe members", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const badAttrErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE",
    );
    expect(badAttrErrors).toHaveLength(0);
  });

  it("emits ERR_BAD_ATTR_VALUE for an empty @values array", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    "@values": [],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("does NOT emit an error for underscore-prefixed members (valid identifiers)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Item",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "type",
                    "@values": ["_DEFAULT", "A", "B_C"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const badAttrErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE",
    );
    expect(badAttrErrors).toHaveLength(0);
  });
});
