import { describe, it, expect } from "bun:test";
import { TypeId, TypeRegistry, type AttrSchema } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import type { MetaModel } from "../src/meta/meta-data.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  OBJECT_SUBTYPE_ENTITY,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubFactory = (): MetaModel => null as unknown as MetaModel;

function makeMinimalDef(type: string, subType: string, attributes: AttrSchema[] = []) {
  return {
    typeId: new TypeId(type, subType),
    description: `Test def for ${type}.${subType}`,
    factory: (_typeId: TypeId, _name: string) => stubFactory(),
    childRules: [],
    attributes,
  };
}

// ---------------------------------------------------------------------------
// AttrSchema — shape and typing
// ---------------------------------------------------------------------------

describe("AttrSchema — shape", () => {
  it("a required AttrSchema with no optional fields is well-typed", () => {
    const schema: AttrSchema = {
      name: "dbColumn",
      valueType: ATTR_SUBTYPE_STRING,
      required: false,
      description: "Override the column name in the DB schema.",
    };
    expect(schema.name).toBe("dbColumn");
    expect(schema.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(schema.required).toBe(false);
    expect(schema.description).toBeDefined();
    // optional fields absent
    expect(schema.default).toBeUndefined();
    expect(schema.allowedValues).toBeUndefined();
  });

  it("an AttrSchema with all optional fields is well-typed", () => {
    const schema: AttrSchema = {
      name: "autoSet",
      valueType: ATTR_SUBTYPE_STRING,
      required: false,
      default: "onCreate",
      allowedValues: ["onCreate", "onUpdate"] as const,
      description: "Auto-set semantics for timestamp fields.",
    };
    expect(schema.default).toBe("onCreate");
    expect(schema.allowedValues).toEqual(["onCreate", "onUpdate"]);
  });

  it("an AttrSchema with a numeric default is well-typed", () => {
    const schema: AttrSchema = {
      name: "maxLength",
      valueType: ATTR_SUBTYPE_INT,
      required: false,
      default: 255,
      description: "Maximum character length for string fields.",
    };
    expect(schema.default).toBe(255);
  });

  it("an AttrSchema with a boolean default is well-typed", () => {
    const schema: AttrSchema = {
      name: "required",
      valueType: ATTR_SUBTYPE_BOOLEAN,
      required: false,
      default: false,
      description: "Whether the field value is mandatory.",
    };
    expect(schema.default).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TypeDefinition — attributes field default
// ---------------------------------------------------------------------------

describe("TypeDefinition — attributes default", () => {
  it("a TypeDefinition registered without attributes has attributes: []", () => {
    const registry = new TypeRegistry();
    registry.register(makeMinimalDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(def).toBeDefined();
    expect(def!.attributes).toEqual([]);
  });

  it("a TypeDefinition registered with attributes round-trips via find()", () => {
    const registry = new TypeRegistry();
    const attrs: AttrSchema[] = [
      {
        name: "currency",
        valueType: ATTR_SUBTYPE_STRING,
        required: false,
        default: "USD",
        description: "ISO 4217 currency code.",
      },
    ];
    registry.register(makeMinimalDef(TYPE_FIELD, "currency", attrs));
    const def = registry.find(TYPE_FIELD, "currency");
    expect(def).toBeDefined();
    expect(def!.attributes).toEqual(attrs);
    expect(def!.attributes[0].name).toBe("currency");
    expect(def!.attributes[0].default).toBe("USD");
  });

  it("multiple AttrSchema entries in the array are preserved in order", () => {
    const registry = new TypeRegistry();
    const attrs: AttrSchema[] = [
      { name: "aaa", valueType: ATTR_SUBTYPE_STRING, required: true, description: "first" },
      { name: "bbb", valueType: ATTR_SUBTYPE_INT, required: false, description: "second" },
      { name: "ccc", valueType: ATTR_SUBTYPE_BOOLEAN, required: false, description: "third" },
    ];
    registry.register(makeMinimalDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, attrs));
    const def = registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    expect(def!.attributes).toHaveLength(3);
    expect(def!.attributes.map((a) => a.name)).toEqual(["aaa", "bbb", "ccc"]);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry.attrsOf()
// ---------------------------------------------------------------------------

describe("TypeRegistry.attrsOf()", () => {
  it("returns [] for an unregistered (type, subType)", () => {
    const registry = new TypeRegistry();
    expect(registry.attrsOf("nonexistent", "type")).toEqual([]);
  });

  it("returns [] for a registered type with no attributes declared", () => {
    const registry = new TypeRegistry();
    registry.register(makeMinimalDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(registry.attrsOf(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toEqual([]);
  });

  it("returns the declared attributes for a registered type", () => {
    const registry = new TypeRegistry();
    const attrs: AttrSchema[] = [
      { name: "locale", valueType: ATTR_SUBTYPE_STRING, required: false, description: "BCP 47 locale." },
    ];
    registry.register(makeMinimalDef(TYPE_FIELD, "currency", attrs));
    const result = registry.attrsOf(TYPE_FIELD, "currency");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("locale");
  });

  it("returns [] when type matches but subType does not", () => {
    const registry = new TypeRegistry();
    const attrs: AttrSchema[] = [
      { name: "locale", valueType: ATTR_SUBTYPE_STRING, required: false, description: "BCP 47 locale." },
    ];
    registry.register(makeMinimalDef(TYPE_FIELD, "currency", attrs));
    expect(registry.attrsOf(TYPE_FIELD, "string")).toEqual([]);
  });

  it("attrsOf for core types (via registerCoreTypes) returns [] for every subType (Phase A1)", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    // All core type definitions ship with attributes: [] in Phase A1.
    for (const typeId of registry.allTypes()) {
      const result = registry.attrsOf(typeId.type, typeId.subType);
      expect(result).toEqual([]);
    }
  });
});
