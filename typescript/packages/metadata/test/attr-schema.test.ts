import { describe, it, expect } from "bun:test";
import { TypeId, TypeRegistry, type AttrSchema } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import type { MetaModel } from "../src/meta/meta-data.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_IDENTITY,
  TYPE_SOURCE,
  TYPE_ORIGIN,
  TYPE_LAYOUT,
  TYPE_VIEW,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  FIELD_SUBTYPE_STRING,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_ARRAY,
  SUBTYPE_BASE,
  FIELD_SUBTYPE_CURRENCY,
  OBJECT_SUBTYPE_ENTITY,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  LAYOUT_SUBTYPE_DATA_GRID,
  VIEW_SUBTYPE_CURRENCY,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
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

  it("attrsOf for core types (via registerCoreTypes) returns a populated schema (Phase A2)", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    // After A2, at least some core subtypes carry attribute schemas.
    const populated = registry
      .allTypes()
      .some((t) => registry.attrsOf(t.type, t.subType).length > 0);
    expect(populated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase A2 — populated core-type attribute schemas
// ---------------------------------------------------------------------------

describe("Phase A2 — core attribute schemas", () => {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);

  const byName = (type: string, subType: string) => {
    const m = new Map<string, AttrSchema>();
    for (const a of registry.attrsOf(type, subType)) m.set(a.name, a);
    return m;
  };

  it("origin.aggregate declares @agg, @of, @via — all required", () => {
    const attrs = byName(TYPE_ORIGIN, ORIGIN_SUBTYPE_AGGREGATE);
    for (const n of ["agg", "of", "via"]) {
      expect(attrs.get(n)).toBeDefined();
      expect(attrs.get(n)!.required).toBe(true);
    }
    expect(attrs.get("agg")!.allowedValues).toEqual(["count", "sum", "avg", "min", "max"]);
  });

  it("origin.passthrough declares @from (required) and @via (optional)", () => {
    const attrs = byName(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH);
    expect(attrs.get("from")!.required).toBe(true);
    expect(attrs.get("via")!.required).toBe(false);
  });

  it("field.currency declares @currency with default 'USD'", () => {
    const attrs = byName(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY);
    const currency = attrs.get("currency");
    expect(currency).toBeDefined();
    expect(currency!.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(currency!.default).toBe("USD");
    expect(currency!.required).toBe(false);
  });

  it("non-currency field subtypes do NOT declare @currency", () => {
    const attrs = byName(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(attrs.get("currency")).toBeUndefined();
    // but they DO carry the common field attrs
    expect(attrs.get("dbColumn")).toBeDefined();
    expect(attrs.get("filterable")!.valueType).toBe(ATTR_SUBTYPE_BOOLEAN);
  });

  it("view.currency declares @locale with default 'en-US'", () => {
    const attrs = byName(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY);
    expect(attrs.get("locale")!.default).toBe("en-US");
  });

  it("layout.dataGrid declares @pageSize as int and @defaultSortOrder enum", () => {
    const attrs = byName(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID);
    expect(attrs.get("pageSize")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("columns")!.valueType).toBe(ATTR_SUBTYPE_STRINGARRAY);
    expect(attrs.get("defaultSortOrder")!.allowedValues).toEqual(["asc", "desc"]);
  });

  it("identity.primary declares required @fields (stringarray) and @generation enum", () => {
    const attrs = byName(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY);
    expect(attrs.get("fields")!.required).toBe(true);
    expect(attrs.get("fields")!.valueType).toBe(ATTR_SUBTYPE_STRINGARRAY);
    expect(attrs.get("generation")!.allowedValues).toEqual(["increment", "uuid", "assigned"]);
  });

  it("identity.secondary declares required @fields and optional @unique", () => {
    const attrs = byName(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY);
    expect(attrs.get("fields")!.required).toBe(true);
    expect(attrs.get("unique")!.required).toBe(false);
    expect(attrs.get("generation")).toBeUndefined();
  });

  it("source.dbTable and source.dbView declare optional @name", () => {
    for (const st of [SOURCE_SUBTYPE_DB_TABLE, SOURCE_SUBTYPE_DB_VIEW]) {
      const attrs = byName(TYPE_SOURCE, st);
      expect(attrs.get("name")!.required).toBe(false);
    }
  });

  it("relationship.association declares cardinality/objectRef/fkField/joinEntity/joinFields", () => {
    const attrs = byName(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION);
    for (const n of ["cardinality", "objectRef", "fkField", "joinEntity", "joinFields"]) {
      expect(attrs.get(n)).toBeDefined();
      expect(attrs.get(n)!.required).toBe(false);
    }
    expect(attrs.get("joinFields")!.valueType).toBe(ATTR_SUBTYPE_STRINGARRAY);
  });

  it("validator.length declares @min and @max (int, optional) — read via this.attr()", () => {
    const attrs = byName(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH);
    expect(attrs.get("min")).toBeDefined();
    expect(attrs.get("min")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("min")!.required).toBe(false);
    expect(attrs.get("max")).toBeDefined();
    expect(attrs.get("max")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("max")!.required).toBe(false);
  });

  it("validator.numeric declares @min and @max (int, optional)", () => {
    const attrs = byName(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_NUMERIC);
    expect(attrs.get("min")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("max")!.valueType).toBe(ATTR_SUBTYPE_INT);
  });

  it("validator.regex declares @min, @max, and @pattern (string, optional)", () => {
    const attrs = byName(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX);
    expect(attrs.get("min")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("max")!.valueType).toBe(ATTR_SUBTYPE_INT);
    const pattern = attrs.get("pattern");
    expect(pattern).toBeDefined();
    expect(pattern!.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(pattern!.required).toBe(false);
  });

  it("validator.required declares no attributes", () => {
    const attrs = byName(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED);
    expect(attrs.size).toBe(0);
  });

  it("validator.array declares @min and @max (int, optional)", () => {
    const attrs = byName(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_ARRAY);
    expect(attrs.get("min")!.valueType).toBe(ATTR_SUBTYPE_INT);
    expect(attrs.get("max")!.valueType).toBe(ATTR_SUBTYPE_INT);
  });

  it("validator.base declares @min and @max (MetaValidator reads them on the base class)", () => {
    const attrs = byName(TYPE_VALIDATOR, SUBTYPE_BASE);
    expect(attrs.get("min")).toBeDefined();
    expect(attrs.get("max")).toBeDefined();
  });
});
