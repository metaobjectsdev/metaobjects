// server/typescript/packages/codegen-ts/src/templates/recover-schema-emitter.ts
//
// Turns a payload value-object into TS source fragments for the FR-010 recover codegen:
//   • schemaLiteral     — a `recoverSchema(Format.JSON, "root", [ … ])` baked descriptor
//                         built from FieldSpec factories (scalar / enumField).
//   • mirrorInterface   — an all-nullable mirror interface `<Payload>Recovered` (each
//                         component `T | null`); recover returns this nullable twin rather
//                         than the strict payload (same reasoning as the Java/C#/Kotlin ports).
//   • mirrorInitializer — `{ prop: asString(d, "prop"), … }` building the mirror from the
//                         forgiving outcome map `d`.
//
// Mirrors the C# RecoverSchemaEmitter (adapted to TS syntax + the `| null` nullable mirror).
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
  scalarKind,
  mirrorType,
  recoverMapCall,
  enumValues,
  jsonStringLiteral,
  stringArrayLiteral,
  propertiesMapLiteral,
} from "./fr010-field-mapping.js";

/** Emit `recoverSchema(Format.X, "rootName", [ … ])`. */
export function schemaLiteral(vo: MetaData, format: string, rootName: string): string {
  const formatEnum = format.toLowerCase() === "xml" ? "Format.XML" : "Format.JSON";
  const specs = fields(vo).map(fieldSpecLiteral);
  return `recoverSchema(${formatEnum}, ${jsonStringLiteral(rootName)}, [${specs.join(", ")}])`;
}

function fieldSpecLiteral(field: MetaData): string {
  const name = jsonStringLiteral(field.name);
  const required = isRequired(field);

  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const valuesLit = stringArrayLiteral(enumValues(field));
    const aliasLit = propertiesMapLiteral(field.ownAttr(FIELD_ATTR_ENUM_ALIAS));
    // enumField() sets array:false; enum-array is a bounded deferral (parity with Java/C#).
    return `enumField(${name}, ${required}, ${valuesLit}, ${aliasLit})`;
  }

  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    // FR-010: nested recover deferred — treat as an opaque required/optional string slot.
    return `scalar(${name}, FieldKind.STRING, ${required}) /* FR-010: nested recover deferred */`;
  }

  const kind = scalarKind(field.subType) ?? "STRING";
  // Scalar-array: the scalar() factory only builds singular specs (array:false), so emit a
  // FieldSpec object literal with array:true. Tier-2 win over the Roslyn proof: the emitted
  // recover() actually populates the array at runtime (RecoverMap.asStringList).
  if (isArray(field)) {
    return (
      `{ name: ${name}, kind: FieldKind.${kind}, required: ${required}, array: true, ` +
      `enumValues: null, enumAlias: null, min: null, max: null, nested: null }`
    );
  }
  return `scalar(${name}, FieldKind.${kind}, ${required})`;
}

/** Emit the all-nullable mirror interface declaration. */
export function mirrorInterface(vo: MetaData, interfaceName: string): string {
  const base = interfaceName.endsWith("Recovered")
    ? interfaceName.slice(0, -"Recovered".length)
    : interfaceName;
  const lines: string[] = [];
  lines.push(
    `/** Best-effort recovered twin of \`${base}\` — every field nullable (null where lost/malformed). */`,
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
  const assigns = fields(vo).map((f) => `${f.name}: ${recoverMapCall(f)}`);
  return `{ ${assigns.join(", ")} }`;
}
