// server/typescript/packages/codegen-ts/src/templates/fr010-field-mapping.ts
//
// Shared field-kind mapping for the FR-010 codegen emitters (recover-schema-emitter +
// output-format-spec-emitter). Maps a metadata field subtype onto the render engine's
// FieldKind member, the idiomatic nullable TS type used by the recover mirror interface,
// and the RecoverMap accessor that reads it from the forgiving outcome map.
//
// Mirrors the C# Fr010FieldMapping (adapted to TS syntax + the `| null` nullable mirror).
// Bounded scope (parity with Java/Kotlin/C#): scalar / enum / scalar-array. Nested object +
// array-of-enum are deferred.

import {
  type MetaData,
  TYPE_FIELD,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_VALUES,
} from "@metaobjectsdev/metadata";

/** The render-engine FieldKind member name for a scalar field subtype, or null if non-scalar. */
export function scalarKind(subType: string): string | null {
  switch (subType) {
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_CLASS:
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
      return "STRING";
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_SHORT:
    case FIELD_SUBTYPE_BYTE:
      return "INT";
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:
      return "LONG";
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
    case FIELD_SUBTYPE_DECIMAL:
      return "DOUBLE";
    case FIELD_SUBTYPE_BOOLEAN:
      return "BOOLEAN";
    default:
      return null;
  }
}

/** The field children of a payload value-object, in declaration order. */
export function fields(vo: MetaData): MetaData[] {
  return vo.children().filter((c) => c.type === TYPE_FIELD);
}

/** isArray is a native (reserved) property on MetaData, not an attr. */
export function isArray(field: MetaData): boolean {
  return field.isArray === true;
}

/** True iff the field's @required is explicitly true (or the string "true"). */
export function isRequired(field: MetaData): boolean {
  const v = field.ownAttr(FIELD_ATTR_REQUIRED);
  if (v === true) return true;
  return typeof v === "string" && v.toLowerCase() === "true";
}

/** The string members of an enum field's @values attr (empty when absent). */
export function enumValues(field: MetaData): string[] {
  const v = field.ownAttr(FIELD_ATTR_VALUES);
  if (Array.isArray(v)) return v.map((e) => String(e));
  return [];
}

/** The nullable TS type for a field in the recover mirror interface. */
export function mirrorType(field: MetaData): string {
  // Matches asStringList's `(string | null)[] | null` return — a recovered array
  // can contain null elements where individual items were lost.
  if (isArray(field)) return "(string | null)[] | null";
  if (field.subType === FIELD_SUBTYPE_OBJECT) return "unknown"; // nested deferred
  if (field.subType === FIELD_SUBTYPE_ENUM) return "string | null"; // enum is string-backed
  switch (scalarKind(field.subType)) {
    case "INT":
    case "LONG":
    case "DOUBLE":
      return "number | null";
    case "BOOLEAN":
      return "boolean | null";
    default:
      return "string | null";
  }
}

/**
 * The RecoverMap.as* helper name that reads this field from the forgiving map, or null
 * for a nested object (which emits a null literal, not a helper call). Single source of
 * truth for the per-field dispatch — both recoverMapCall and recoverMapHelpersUsed use it.
 */
function recoverMapHelper(field: MetaData): string | null {
  if (isArray(field)) return "asStringList";
  if (field.subType === FIELD_SUBTYPE_OBJECT) return null; // null literal, no helper
  if (field.subType === FIELD_SUBTYPE_ENUM) return "asString";
  switch (scalarKind(field.subType)) {
    case "INT":
      return "asInt";
    case "LONG":
      return "asLong";
    case "DOUBLE":
      return "asDouble";
    case "BOOLEAN":
      return "asBool";
    default:
      return "asString";
  }
}

/** The RecoverMap.as* helper name + call that reads this field from the forgiving map `d`. */
export function recoverMapCall(field: MetaData): string {
  const helper = recoverMapHelper(field);
  if (helper === null) return "null /* FR-010: nested recover deferred */";
  return `${helper}(d, ${jsonStringLiteral(field.name)})`;
}

/** Distinct RecoverMap helper names used across a value-object's fields (for the import). */
export function recoverMapHelpersUsed(vo: MetaData): string[] {
  const used = new Set<string>();
  for (const f of fields(vo)) {
    const helper = recoverMapHelper(f);
    if (helper !== null) used.add(helper);
  }
  return [...used].sort();
}

/** A TS double-quoted string literal for `value`, with the load-bearing chars escaped. */
export function jsonStringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

/** A TS array literal `["a", "b"]` for the given members. */
export function stringArrayLiteral(values: readonly string[]): string {
  return "[" + values.map((v) => jsonStringLiteral(v)).join(", ") + "]";
}

/**
 * A TS object literal `{ "k": "v", … }` for a properties-shaped attr (e.g. @enumAlias /
 * @enumDoc), or "null" when absent/empty. Null values are dropped; keys are sorted
 * ordinally for deterministic output (matches the canonical-serializer properties sort).
 */
export function propertiesMapLiteral(attr: unknown): string {
  if (attr == null || typeof attr !== "object" || Array.isArray(attr)) return "null";
  const d = attr as Record<string, unknown>;
  const entries = Object.keys(d)
    .filter((k) => d[k] != null)
    .sort()
    .map((k) => `${jsonStringLiteral(k)}: ${jsonStringLiteral(String(d[k]))}`);
  if (entries.length === 0) return "null";
  return "{ " + entries.join(", ") + " }";
}
