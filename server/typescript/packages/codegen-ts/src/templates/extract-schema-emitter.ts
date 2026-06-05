// server/typescript/packages/codegen-ts/src/templates/extract-schema-emitter.ts
//
// Turns a payload value-object into TS source fragments for the FR-010 extract codegen:
//   • schemaLiteral     — a `extractSchema(Format.JSON, "root", [ … ])` baked descriptor
//                         built from FieldSpec factories (scalar / enumField).
//   • mirrorInterface   — an all-nullable mirror interface `<Payload>Extracted` (each
//                         component `T | null`); extract returns this nullable twin rather
//                         than the strict payload (same reasoning as the Java/C#/Kotlin ports).
//   • mirrorInitializer — `{ prop: asString(d, "prop"), … }` building the mirror from the
//                         forgiving outcome map `d`.
//
// Mirrors the C# ExtractSchemaEmitter (adapted to TS syntax + the `| null` nullable mirror).
// Bounded scope: scalar / enum / scalar-array. Nested object + array-of-enum deferred.

import {
  type MetaData,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_ENUM_ALIAS,
} from "@metaobjectsdev/metadata";
import {
  fields,
  isRequired,
  isArray,
  xmlText,
  scalarKind,
  mirrorType,
  extractMapCall,
  enumValues,
  coerceDefault,
  defaultValue,
  resolveNormalize,
  jsonStringLiteral,
  stringArrayLiteral,
  propertiesMapLiteral,
} from "./fr010-field-mapping.js";
import { NORMALIZE_DEFAULT } from "@metaobjectsdev/metadata";

/** Emit `extractSchema(Format.X, "rootName", [ … ])`. */
export function schemaLiteral(vo: MetaData, format: string, rootName: string): string {
  const formatEnum = format.toLowerCase() === "xml" ? "Format.XML" : "Format.JSON";
  const specs = fields(vo).map((f) => fieldSpecLiteral(f, vo));
  return `extractSchema(${formatEnum}, ${jsonStringLiteral(rootName)}, [${specs.join(", ")}])`;
}

function fieldSpecLiteral(field: MetaData, owner: MetaData): string {
  const name = jsonStringLiteral(field.name);
  const required = isRequired(field);

  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const valuesLit = stringArrayLiteral(enumValues(field));
    const aliasLit = propertiesMapLiteral(field.ownAttr(FIELD_ATTR_ENUM_ALIAS));
    // FR-011: extended enumField signature is (name, required, values, aliases,
    // coerceDefault?, normalize="strip", defaultValue?). Resolve the three new args
    // (field → object → "strip" for normalize) and emit only what's needed: keep the
    // back-compat 4-arg form when nothing is set, else emit the positional tail up to
    // the last meaningful arg.
    const cd = coerceDefault(field);
    const dv = defaultValue(field);
    const normalize = resolveNormalize(field, owner);
    // enumField() sets array:false; enum-array is a bounded deferral (parity with Java/C#).
    if (cd == null && dv == null && normalize === NORMALIZE_DEFAULT) {
      return `enumField(${name}, ${required}, ${valuesLit}, ${aliasLit})`;
    }
    const cdLit = cd == null ? "null" : jsonStringLiteral(cd);
    const normLit = jsonStringLiteral(normalize);
    if (dv == null) {
      return `enumField(${name}, ${required}, ${valuesLit}, ${aliasLit}, ${cdLit}, ${normLit})`;
    }
    return `enumField(${name}, ${required}, ${valuesLit}, ${aliasLit}, ${cdLit}, ${normLit}, ${jsonStringLiteral(dv)})`;
  }

  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    // FR-010: nested extract deferred — treat as an opaque required/optional string slot.
    return `scalar(${name}, FieldKind.STRING, ${required}) /* FR-010: nested extract deferred */`;
  }

  const kind = scalarKind(field.subType) ?? "STRING";
  // Scalar-array: the scalar() factory only builds singular specs (array:false), so emit a
  // FieldSpec object literal with array:true. Tier-2 win over the Roslyn proof: the emitted
  // extract() actually populates the array at runtime (ExtractMap.asStringList).
  if (isArray(field)) {
    return (
      `{ name: ${name}, kind: FieldKind.${kind}, required: ${required}, array: true, ` +
      `enumValues: null, enumAlias: null, min: null, max: null, nested: null }`
    );
  }
  // @xmlText: a scalar field marked to receive its element's XML text content.
  if (xmlText(field)) {
    return `textContentField(${name}, FieldKind.${kind}, ${required})`;
  }
  return `scalar(${name}, FieldKind.${kind}, ${required})`;
}

/** Emit the all-nullable mirror interface declaration. */
export function mirrorInterface(vo: MetaData, interfaceName: string): string {
  const base = interfaceName.endsWith("Extracted")
    ? interfaceName.slice(0, -"Extracted".length)
    : interfaceName;
  const lines: string[] = [];
  lines.push(
    `/** Best-effort extracted twin of \`${base}\` — every field nullable (null where lost/malformed). */`,
  );
  lines.push(`export interface ${interfaceName} {`);
  for (const f of fields(vo)) {
    lines.push(`  ${f.name}: ${mirrorType(f)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Emit `{ prop: asString(d, "prop"), … }` building the mirror from the forgiving map `d`. */
export function mirrorInitializer(vo: MetaData): string {
  const assigns = fields(vo).map((f) => `${f.name}: ${extractMapCall(f)}`);
  return `{ ${assigns.join(", ")} }`;
}
