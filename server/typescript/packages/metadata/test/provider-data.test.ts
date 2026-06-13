// FR-033 — provider-data format + defineProviderFromData builder tests.
import { test, expect } from "bun:test";
import {
  defineProviderFromData,
  type ProviderDefinition,
} from "../src/provider-data.js";
import { TypeId, TypeRegistry } from "../src/registry.js";
import { MetaField } from "../src/core/field/meta-field.js";

const FIELD_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);

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
