// field-definition-completeness — proves the FR-033 STRICT per-subtype field
// model (spec/metamodel/field.json, read via defineProviderFromData with
// extendsBase composition) is FAITHFUL and COMPLETE: a composed core registry
// registers, for every field subtype, exactly the expected attr name-set
// (+ valueType + required) and dataType.
//
// FR-033 S1-field-B made the field model STRICT and per-subtype:
//   - field.base carries the UNIVERSAL core attrs (@required/@readOnly/@default/
//     @unique). Every concrete subtype extendsBase:true to inherit them.
//   - each concrete subtype adds ONLY its subtype-specific core attrs:
//       string   → @maxLength
//       decimal  → @precision, @scale
//       object   → @objectRef
//       currency → @currency
//       enum     → @values, @provided
//       int/long/double/float/boolean/date/time/timestamp/uuid → none
//   - the "any attr" wildcard is gone; a misplaced attr is now ERR_UNKNOWN_ATTR.
//
// The concern providers (composed in coreProviders) layer on:
//   - metaobjects-db: @column/@db.indexed/@dbColumnType on EVERY field;
//     @storage on field.object ONLY; @autoSet on date/time/timestamp ONLY.
//   - metaobjects-ui: @filterable/@sortable/@sortableDefaultOrder on every field.
//   - metaobjects-prompt: @xmlText/@example/@instruction on every field; the
//     @enumAlias/@enumDoc/@coerceDefault/@normalize overlays on field.enum.
//
// This gate composes the WHOLE coreProviders bundle and asserts the complete
// per-subtype attr set — the strict safety net (e.g. field.boolean does NOT carry
// @maxLength/@precision/@storage/@objectRef; field.string DOES carry @maxLength
// but NOT @precision/@storage; only field.object carries @storage/@objectRef).
// (Doc commonAttrs are registered at the registry level, NOT per-type, so they
// do not appear in `def.attributes`.)

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { TYPE_FIELD } from "../src/shared/base-types.js";
import {
  FIELD_SUBTYPES,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../src/core/field/field-constants.js";

const registry = composeRegistry([...coreProviders]);

type AttrExp = { valueType: string | null; required: boolean };

/** The UNIVERSAL attrs every field subtype carries after composing the full
 *  coreProviders bundle: the core base attrs (@required/@readOnly/@default/
 *  @unique) + the always-on db column attrs + the always-on ui markers + the
 *  always-on prompt markers. Subtype-specific core attrs (@maxLength/@precision/
 *  @scale/@objectRef/@currency/@values/@provided) and scoped concern attrs
 *  (@storage/@autoSet/enum overlays) are NOT here — they are added per subtype. */
const UNIVERSAL: Record<string, AttrExp> = {
  // core-types base — universal intrinsic shape
  required: { valueType: "boolean", required: false },
  readOnly: { valueType: "boolean", required: false },
  unique: { valueType: "boolean", required: false },
  default: { valueType: null, required: false },
  // metaobjects-db — every field is a column
  column: { valueType: "string", required: false },
  "db.indexed": { valueType: "boolean", required: false },
  dbColumnType: { valueType: "string", required: false },
  // metaobjects-ui — presentation + query surface (legitimately any field)
  filterable: { valueType: "boolean", required: false },
  sortable: { valueType: "boolean", required: false },
  sortableDefaultOrder: { valueType: "string", required: false },
  formExclude: { valueType: "boolean", required: false },
  // metaobjects-prompt — AI + serialization (legitimately any field)
  xmlText: { valueType: "boolean", required: false },
  example: { valueType: "string", required: false },
  instruction: { valueType: "string", required: false },
};

/** Subtype-specific core attrs (from field.json). */
const STRING_EXTRA: Record<string, AttrExp> = {
  maxLength: { valueType: "int", required: false },
  // ADR-0036/0037 Wave 3 — @stringFormat (email|hostname) on field.string ONLY.
  stringFormat: { valueType: "string", required: false },
};
const DECIMAL_EXTRA: Record<string, AttrExp> = {
  precision: { valueType: "int", required: false },
  scale: { valueType: "int", required: false },
};
const OBJECT_CORE_EXTRA: Record<string, AttrExp> = {
  objectRef: { valueType: "string", required: false },
};
const CURRENCY_EXTRA: Record<string, AttrExp> = {
  currency: { valueType: "string", required: false },
};
// field.map carries @valueType (scalar value subtype) + @objectRef (VO value);
// exactly one is set per instance (a loader rule, not a registration concern).
const MAP_EXTRA: Record<string, AttrExp> = {
  valueType: { valueType: "string", required: false },
  objectRef: { valueType: "string", required: false },
};
const ENUM_CORE_EXTRA: Record<string, AttrExp> = {
  values: { valueType: "string", required: true },
  provided: { valueType: "boolean", required: false },
};

/** Scoped concern attrs (db / prompt). */
const STORAGE_EXTRA: Record<string, AttrExp> = {
  storage: { valueType: "string", required: false },
};
const AUTO_SET_EXTRA: Record<string, AttrExp> = {
  autoSet: { valueType: "string", required: false },
};
// ADR-0036 Wave 2 — @localTime (the naive opt-out) on field.timestamp ONLY.
const LOCAL_TIME_EXTRA: Record<string, AttrExp> = {
  localTime: { valueType: "boolean", required: false },
};
const ENUM_PROMPT_EXTRA: Record<string, AttrExp> = {
  enumAlias: { valueType: "properties", required: false },
  enumDoc: { valueType: "properties", required: false },
  coerceDefault: { valueType: "string", required: false },
  normalize: { valueType: "string", required: false },
};

const TEMPORAL = new Set<string>([
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
]);

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
  map: "object",
  currency: "long",
  enum: "string",
  uuid: "string",
  // ADR-0036/0037 Wave 3 — uri/inet bind to TS string.
  uri: "string",
  inet: "string",
};

function expectedAttrsFor(subType: string): Record<string, AttrExp> {
  const exp: Record<string, AttrExp> = { ...UNIVERSAL };
  if (subType === FIELD_SUBTYPE_STRING) Object.assign(exp, STRING_EXTRA);
  if (subType === FIELD_SUBTYPE_DECIMAL) Object.assign(exp, DECIMAL_EXTRA);
  if (subType === FIELD_SUBTYPE_OBJECT) Object.assign(exp, OBJECT_CORE_EXTRA, STORAGE_EXTRA);
  if (subType === FIELD_SUBTYPE_MAP) Object.assign(exp, MAP_EXTRA);
  if (subType === FIELD_SUBTYPE_CURRENCY) Object.assign(exp, CURRENCY_EXTRA);
  if (subType === FIELD_SUBTYPE_ENUM) Object.assign(exp, ENUM_CORE_EXTRA, ENUM_PROMPT_EXTRA);
  if (TEMPORAL.has(subType)) Object.assign(exp, AUTO_SET_EXTRA);
  if (subType === FIELD_SUBTYPE_TIMESTAMP) Object.assign(exp, LOCAL_TIME_EXTRA);
  return exp;
}

describe("field provider externalization — strict per-subtype completeness", () => {
  test("registers all 18 field subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_FIELD).sort();
    expect(registered).toEqual([...FIELD_SUBTYPES].sort());
  });

  for (const subType of FIELD_SUBTYPES) {
    test(`field.${subType} — attr name-set, valueType, required, dataType match the strict model`, () => {
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

  // --- Strict-model spot-checks: the per-subtype scoping actually bites. ---

  test("field.string carries @maxLength but NOT @precision/@scale/@storage/@objectRef/@currency/@values/@autoSet", () => {
    const names = new Set(registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING)!.attributes.map((a) => a.name));
    expect(names.has("maxLength")).toBe(true);
    for (const off of ["precision", "scale", "storage", "objectRef", "currency", "values", "autoSet"]) {
      expect(names.has(off)).toBe(false);
    }
  });

  test("field.boolean carries NONE of the subtype-specific attrs", () => {
    const names = new Set(registry.find(TYPE_FIELD, "boolean")!.attributes.map((a) => a.name));
    for (const off of ["maxLength", "precision", "scale", "storage", "objectRef", "currency", "values", "autoSet"]) {
      expect(names.has(off)).toBe(false);
    }
  });

  test("field.decimal carries @precision/@scale but NOT @maxLength/@storage", () => {
    const names = new Set(registry.find(TYPE_FIELD, FIELD_SUBTYPE_DECIMAL)!.attributes.map((a) => a.name));
    expect(names.has("precision")).toBe(true);
    expect(names.has("scale")).toBe(true);
    expect(names.has("maxLength")).toBe(false);
    expect(names.has("storage")).toBe(false);
  });

  test("field.object carries @objectRef/@storage but NOT @maxLength/@precision", () => {
    const names = new Set(registry.find(TYPE_FIELD, FIELD_SUBTYPE_OBJECT)!.attributes.map((a) => a.name));
    expect(names.has("objectRef")).toBe(true);
    expect(names.has("storage")).toBe(true);
    expect(names.has("maxLength")).toBe(false);
    expect(names.has("precision")).toBe(false);
  });

  test("@autoSet is scoped to the temporal subtypes only", () => {
    for (const subType of FIELD_SUBTYPES) {
      const has = registry
        .find(TYPE_FIELD, subType)!
        .attributes.some((a) => a.name === "autoSet");
      expect(has).toBe(TEMPORAL.has(subType));
    }
  });

  test("@values on field.enum is array-valued (isArray:true)", () => {
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_ENUM)!;
    const values = def.attributes.find((a) => a.name === "values");
    expect(values?.isArray).toBe(true);
  });
});
