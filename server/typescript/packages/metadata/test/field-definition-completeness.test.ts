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
import { coreProviders } from "../src/core-types.js";
import { TYPE_FIELD } from "../src/shared/base-types.js";
import { FIELD_SUBTYPES } from "../src/core/field/field-constants.js";

// FR-033 S1-field-A re-homed the field's filter/sort/teaching/extract/storage
// attrs OUT of the core field definition and INTO the concern providers
// (metaobjects-db: @storage/@autoSet + @column/@db.indexed/@dbColumnType;
// metaobjects-ui: @filterable/@sortable/@sortableDefaultOrder; metaobjects-prompt:
// @xmlText/@example/@instruction + the enum extract attrs). The COMPOSED registry
// still carries the full set, so this gate composes the WHOLE coreProviders bundle
// (not coreTypesProvider alone) and asserts the complete per-subtype attr set —
// the externalization + re-homing safety net. (Doc commonAttrs are registered at
// the registry level, NOT per-type, so they do not appear in `def.attributes`.)
const registry = composeRegistry([...coreProviders]);

/** The common attrs (name → {valueType|null, required}) every field subtype carries
 *  after composing the full coreProviders bundle — core intrinsic shape + the
 *  db / ui / prompt concern markers. */
const COMMON: Record<string, { valueType: string | null; required: boolean }> = {
  // core-types — intrinsic logical shape
  objectRef: { valueType: "string", required: false },
  required: { valueType: "boolean", required: false },
  readOnly: { valueType: "boolean", required: false },
  unique: { valueType: "boolean", required: false },
  default: { valueType: null, required: false },
  maxLength: { valueType: "int", required: false },
  precision: { valueType: "int", required: false },
  scale: { valueType: "int", required: false },
  // metaobjects-db — physical storage + DB constraints
  column: { valueType: "string", required: false },
  "db.indexed": { valueType: "boolean", required: false },
  dbColumnType: { valueType: "string", required: false },
  storage: { valueType: "string", required: false },
  autoSet: { valueType: "string", required: false },
  // metaobjects-ui — presentation + query surface
  filterable: { valueType: "boolean", required: false },
  sortable: { valueType: "boolean", required: false },
  sortableDefaultOrder: { valueType: "string", required: false },
  // metaobjects-prompt — AI + serialization
  xmlText: { valueType: "boolean", required: false },
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
