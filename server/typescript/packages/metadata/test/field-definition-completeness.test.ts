// field-definition-completeness — proves the FR-033 externalization of the field
// provider (spec/metamodel/field.json, read via defineProviderFromData) is
// FAITHFUL and COMPLETE: a composed core registry registers, for every field
// subtype, exactly the expected attr name-set (+ valueType + required) and
// dataType that the hand-coded field-schema.ts produced before the conversion.
//
// The expected table below is derived directly from the pre-FR-033
// core/field/field-schema.ts (commonFieldAttrs + the currency/enum specials) and
// field-constants.ts (FIELD_DATA_TYPE). It is the safety net the plan asks for.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_FIELD } from "../src/shared/base-types.js";
import { FIELD_SUBTYPES } from "../src/core/field/field-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the FIELD provider registered, not the db/doc-domain attrs that
// other providers add to every field via registry.extend() (column, dbColumnType,
// db.indexed, xmlText, doc commonAttrs). This isolates the externalization gate.
const registry = composeRegistry([coreTypesProvider]);

/** The 15 common attrs (name → {valueType|null, required}) every field subtype carries. */
const COMMON: Record<string, { valueType: string | null; required: boolean }> = {
  objectRef: { valueType: "string", required: false },
  storage: { valueType: "string", required: false },
  required: { valueType: "boolean", required: false },
  readOnly: { valueType: "boolean", required: false },
  unique: { valueType: "boolean", required: false },
  default: { valueType: null, required: false },
  maxLength: { valueType: "int", required: false },
  precision: { valueType: "int", required: false },
  scale: { valueType: "int", required: false },
  filterable: { valueType: "boolean", required: false },
  sortable: { valueType: "boolean", required: false },
  sortableDefaultOrder: { valueType: "string", required: false },
  autoSet: { valueType: "string", required: false },
  example: { valueType: "string", required: false },
  instruction: { valueType: "string", required: false },
};

const CURRENCY_EXTRA = {
  currency: { valueType: "string", required: false },
};

const ENUM_EXTRA = {
  values: { valueType: "string", required: true },
  provided: { valueType: "boolean", required: false },
  enumAlias: { valueType: "properties", required: false },
  enumDoc: { valueType: "properties", required: false },
  coerceDefault: { valueType: "string", required: false },
  normalize: { valueType: "string", required: false },
};

const EXPECTED_DATA_TYPE: Record<string, string> = {
  base: "string",
  string: "string",
  int: "int",
  long: "long",
  double: "double",
  float: "double",
  decimal: "string",
  boolean: "boolean",
  date: "date",
  time: "date",
  timestamp: "date",
  object: "object",
  currency: "long",
  enum: "string",
  uuid: "string",
};

function expectedAttrsFor(subType: string): Record<string, { valueType: string | null; required: boolean }> {
  if (subType === "currency") return { ...COMMON, ...CURRENCY_EXTRA };
  if (subType === "enum") return { ...COMMON, ...ENUM_EXTRA };
  return { ...COMMON };
}

describe("field provider externalization — completeness", () => {
  test("registers all 15 field subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_FIELD).sort();
    expect(registered).toEqual([...FIELD_SUBTYPES].sort());
  });

  for (const subType of FIELD_SUBTYPES) {
    test(`field.${subType} — attr name-set, valueType, required, dataType match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_FIELD, subType);
      expect(def).toBeDefined();
      const expected = expectedAttrsFor(subType);

      // Attr name-set is exactly the expected set.
      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      // Each attr's valueType + required match.
      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect((attr.valueType ?? null) as string | null).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
      }

      // dataType matches MetaField's internal FIELD_DATA_TYPE map.
      expect(def!.dataType as string | undefined).toBe(EXPECTED_DATA_TYPE[subType]);
    });
  }

  test("@values on field.enum is array-valued (isArray:true)", () => {
    const def = registry.find(TYPE_FIELD, "enum")!;
    const values = def.attributes.find((a) => a.name === "values");
    expect(values?.isArray).toBe(true);
  });
});
