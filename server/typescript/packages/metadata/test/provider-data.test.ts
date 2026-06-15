// FR-033 — provider-data format + defineProviderFromData builder tests.
import { test, expect } from "bun:test";
import {
  defineProviderFromData,
  applyProviderDefinition,
  type ProviderDefinition,
} from "../src/provider-data.js";
import { TypeId, TypeRegistry } from "../src/registry.js";
import { MetaField } from "../src/core/field/meta-field.js";

const FIELD_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);

/** Register a few field subtypes (string/int/object) on a fresh registry so the
 *  S1.5 `extends` path has real targets to extend. */
function registryWithFields(...subTypes: string[]): TypeRegistry {
  const reg = new TypeRegistry();
  const data: ProviderDefinition = {
    provider: "core-fixture",
    types: subTypes.map((subType) => ({ type: "field", subType, description: `field.${subType}` })),
  };
  const factories = Object.fromEntries(subTypes.map((s) => [`field.${s}`, FIELD_FACTORY]));
  applyProviderDefinition(reg, data, factories);
  return reg;
}

test("an attr child entry → produces an AttrSchema (value-type/default/allowedValues/description)", () => {
  const data: ProviderDefinition = {
    provider: "test-fields",
    types: [
      {
        type: "field",
        subType: "currency",
        description: "Stores money as integer minor units (cents).",
        dataType: "long",
        children: [
          {
            type: "attr",
            subType: "string",
            name: "currency",
            min: 0,
            max: 1,
            default: "USD",
            allowedValues: ["USD", "EUR", "JPY"],
            description: "ISO 4217 code; defaults to USD.",
          },
        ],
      },
    ],
  };

  const reg = new TypeRegistry();
  for (const def of defineProviderFromData(data, { "field.currency": FIELD_FACTORY })) {
    reg.register(def);
  }
  const def = reg.find("field", "currency")!;
  expect(def.description).toBe("Stores money as integer minor units (cents).");
  expect(def.dataType).toBe("long");
  expect(def.attributes).toHaveLength(1);
  const attr = def.attributes[0]!;
  expect(attr.name).toBe("currency");
  expect(attr.valueType).toBe("string");
  expect(attr.required).toBe(false);
  expect(attr.default).toBe("USD");
  expect(attr.allowedValues).toEqual(["USD", "EUR", "JPY"]);
  expect(attr.description).toBe("ISO 4217 code; defaults to USD.");
});

test("a required attr (min >= 1) → AttrSchema.required true", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "field",
        subType: "string",
        description: "A text field.",
        children: [
          { type: "attr", subType: "int", name: "maxLength", min: 1, max: 1, description: "Max length." },
        ],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "field.string": FIELD_FACTORY })) reg.register(d);
  expect(reg.find("field", "string")!.attributes[0]!.required).toBe(true);
});

test("a structural child entry → produces a ChildRule with min/max/named", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "object",
        subType: "entity",
        description: "An entity.",
        children: [
          { type: "field", subType: "*", name: "*", min: 0, max: null, description: "Any field." },
          { type: "identity", subType: "primary", name: "*", min: 1, max: 1, named: true },
        ],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "object.entity": FIELD_FACTORY })) reg.register(d);
  const rules = reg.find("object", "entity")!.childRules;
  expect(rules).toHaveLength(2);
  expect(rules[0]).toMatchObject({ childType: "field", childSubType: "*", childName: "*", min: 0, max: null });
  expect(rules[1]).toMatchObject({
    childType: "identity",
    childSubType: "primary",
    childName: "*",
    min: 1,
    max: 1,
    named: true,
  });
  // Attr entries do NOT also become childRules in this task.
  expect(rules.every((r) => r.childType !== "attr")).toBe(true);
});

test("a list-valued subType on a structural child → ChildRule.childSubType is the list", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "object",
        subType: "entity",
        description: "An entity.",
        children: [
          { type: "source", subType: ["rdb", "view"], name: "*", min: 0, max: 1, description: "A source." },
        ],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "object.entity": FIELD_FACTORY })) reg.register(d);
  expect(reg.find("object", "entity")!.childRules[0]!.childSubType).toEqual(["rdb", "view"]);
});

test("missing factory → throws with the type.subType in the message", () => {
  const data: ProviderDefinition = {
    provider: "test-fields",
    types: [{ type: "field", subType: "currency", description: "d" }],
  };
  expect(() => defineProviderFromData(data, {})).toThrow(
    /defineProviderFromData\(test-fields\): no factory for "field\.currency"/,
  );
});

test("rules/example/whenToUse flow onto the registered def and attr", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "field",
        subType: "currency",
        description: "d",
        dataType: "long",
        rules: "Wire format is integer minor units; float money is forbidden.",
        example: '{ "field.currency": { "name": "priceCents" } }',
        whenToUse: "Any monetary amount.",
        children: [
          {
            type: "attr",
            subType: "string",
            name: "currency",
            min: 0,
            max: 1,
            description: "c",
            whenToUse: "When the currency is not USD.",
            rules: "ISO 4217 three-letter code.",
            example: "EUR",
          },
        ],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "field.currency": FIELD_FACTORY })) reg.register(d);
  const def = reg.find("field", "currency")!;
  expect(def.rules).toBe("Wire format is integer minor units; float money is forbidden.");
  expect(def.example).toBe('{ "field.currency": { "name": "priceCents" } }');
  expect(def.whenToUse).toBe("Any monetary amount.");
  const attr = def.attributes[0]!;
  expect(attr.whenToUse).toBe("When the currency is not USD.");
  expect(attr.rules).toBe("ISO 4217 three-letter code.");
  expect(attr.example).toBe("EUR");
});

test("parents flow onto the registered def", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "source",
        subType: "rdb",
        description: "An rdb source.",
        parents: ["object.entity", "object.projection"],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "source.rdb": FIELD_FACTORY })) reg.register(d);
  expect(reg.find("source", "rdb")!.parents).toEqual(["object.entity", "object.projection"]);
});

// ---------------------------------------------------------------------------
// Builder validations (cheap, local)
// ---------------------------------------------------------------------------

test("attr entry with max != 1 and not isArray → throws (attrs are single-valued)", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "field",
        subType: "currency",
        description: "d",
        children: [{ type: "attr", subType: "string", name: "currency", min: 0, max: 2, description: "c" }],
      },
    ],
  };
  expect(() => defineProviderFromData(data, { "field.currency": FIELD_FACTORY })).toThrow(/single-valued/);
});

test("attr entry with max != 1 but isArray → allowed", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "field",
        subType: "enum",
        description: "d",
        children: [
          { type: "attr", subType: "string", name: "values", min: 1, max: null, isArray: true, description: "c" },
        ],
      },
    ],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "field.enum": FIELD_FACTORY })) reg.register(d);
  expect(reg.find("field", "enum")!.attributes[0]!.isArray).toBe(true);
});

test("attr entry with a list subType → throws (an attr value-type is a single subtype)", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "field",
        subType: "currency",
        description: "d",
        children: [
          {
            type: "attr",
            subType: ["string", "int"],
            name: "currency",
            min: 0,
            max: 1,
            description: "c",
          },
        ],
      },
    ],
  };
  expect(() => defineProviderFromData(data, { "field.currency": FIELD_FACTORY })).toThrow(/single subtype/);
});

test("min < 0 → throws", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "object",
        subType: "entity",
        description: "d",
        children: [{ type: "field", subType: "*", name: "*", min: -1, max: null, description: "c" }],
      },
    ],
  };
  expect(() => defineProviderFromData(data, { "object.entity": FIELD_FACTORY })).toThrow(/min/);
});

test("max < min → throws", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [
      {
        type: "object",
        subType: "entity",
        description: "d",
        children: [{ type: "field", subType: "*", name: "*", min: 2, max: 1, description: "c" }],
      },
    ],
  };
  expect(() => defineProviderFromData(data, { "object.entity": FIELD_FACTORY })).toThrow(/max/);
});

// ---------------------------------------------------------------------------
// FR-033 S1.5 — data-driven `extends` (concern providers add attrs to types
// an upstream provider already registered).
// ---------------------------------------------------------------------------

test("extends subType:'*' → fans the attrs out to EVERY registered subtype of the type", () => {
  const reg = registryWithFields("string", "int", "object");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "*",
        children: [
          { type: "attr", subType: "string", name: "column", min: 0, max: 1, description: "Physical column name." },
        ],
      },
    ],
  };
  applyProviderDefinition(reg, data, {});
  for (const sub of ["string", "int", "object"]) {
    const attrs = reg.find("field", sub)!.attributes;
    expect(attrs.map((a) => a.name)).toContain("column");
  }
});

test("extends subType list → targets ONLY the named subtypes", () => {
  const reg = registryWithFields("string", "int", "object");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: ["string", "object"],
        children: [
          { type: "attr", subType: "boolean", name: "db.indexed", min: 0, max: 1, description: "Indexed." },
        ],
      },
    ],
  };
  applyProviderDefinition(reg, data, {});
  expect(reg.find("field", "string")!.attributes.map((a) => a.name)).toContain("db.indexed");
  expect(reg.find("field", "object")!.attributes.map((a) => a.name)).toContain("db.indexed");
  expect(reg.find("field", "int")!.attributes.map((a) => a.name)).not.toContain("db.indexed");
});

test("extends single subType → targets exactly that one subtype", () => {
  const reg = registryWithFields("string", "object");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "object",
        children: [
          { type: "attr", subType: "string", name: "storage", min: 0, max: 1, description: "Storage strategy." },
        ],
      },
    ],
  };
  applyProviderDefinition(reg, data, {});
  expect(reg.find("field", "object")!.attributes.map((a) => a.name)).toContain("storage");
  expect(reg.find("field", "string")!.attributes.map((a) => a.name)).not.toContain("storage");
});

test("extends attrs lower correctly (name/valueType/required/default/allowedValues/description)", () => {
  const reg = registryWithFields("string");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "string",
        children: [
          {
            type: "attr",
            subType: "string",
            name: "storage",
            min: 1,
            max: 1,
            default: "jsonb",
            allowedValues: ["flattened", "jsonb", "subdocument"],
            description: "Storage strategy.",
          },
        ],
      },
    ],
  };
  applyProviderDefinition(reg, data, {});
  const attr = reg.find("field", "string")!.attributes.find((a) => a.name === "storage")!;
  expect(attr.valueType).toBe("string");
  expect(attr.required).toBe(true);
  expect(attr.default).toBe("jsonb");
  expect(attr.allowedValues).toEqual(["flattened", "jsonb", "subdocument"]);
  expect(attr.description).toBe("Storage strategy.");
});

test("extends with a structural child → throws (concern providers add attrs only)", () => {
  const reg = registryWithFields("string");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "string",
        children: [{ type: "validator", subType: "*", name: "*", min: 0, max: null }],
      },
    ],
  };
  expect(() => applyProviderDefinition(reg, data, {})).toThrow(/may only carry attr children/);
});

test("extends targeting an unregistered subtype → throws (registry.extend has no target)", () => {
  const reg = registryWithFields("string");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "object",
        children: [{ type: "attr", subType: "string", name: "storage", min: 0, max: 1, description: "s" }],
      },
    ],
  };
  expect(() => applyProviderDefinition(reg, data, {})).toThrow(/no registered type "field\.object"/);
});

test("a definition with only `extends` (no `types`) is valid (concern provider)", () => {
  const reg = registryWithFields("int");
  const data: ProviderDefinition = {
    provider: "concern",
    extends: [
      {
        type: "field",
        subType: "int",
        children: [{ type: "attr", subType: "string", name: "column", min: 0, max: 1, description: "c" }],
      },
    ],
  };
  expect(() => applyProviderDefinition(reg, data, {})).not.toThrow();
  expect(reg.find("field", "int")!.attributes.map((a) => a.name)).toContain("column");
});

test("a type with no children → empty attributes and childRules", () => {
  const data: ProviderDefinition = {
    provider: "t",
    types: [{ type: "field", subType: "string", description: "A text field." }],
  };
  const reg = new TypeRegistry();
  for (const d of defineProviderFromData(data, { "field.string": FIELD_FACTORY })) reg.register(d);
  const def = reg.find("field", "string")!;
  expect(def.attributes).toEqual([]);
  expect(def.childRules).toEqual([]);
});
