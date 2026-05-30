// server/typescript/packages/codegen-ts/src/templates/output-format-spec-emitter.ts
//
// Turns a payload value-object + its template.output node into a TS source literal for an
// OutputFormatSpec — the artifact-1 prompt descriptor used by the FR-010 output-prompt codegen.
//
// Emits an `{ format, rootName, style, fields: [ … ] } satisfies OutputFormatSpec` literal.
// Mirrors the C# OutputFormatSpecEmitter (adapted to TS syntax). Field-kind mapping is shared
// via fr010-field-mapping. Bounded scope: scalar / enum. Nested object → FieldKind.OBJECT placeholder.

import {
  type MetaData,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_EXAMPLE,
  FIELD_ATTR_INSTRUCTION,
  FIELD_ATTR_ENUM_DOC,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_PROMPT_STYLE,
  PROMPT_STYLE_INLINE,
  PROMPT_STYLE_EXAMPLE_ONLY,
} from "@metaobjectsdev/metadata";
import {
  fields,
  isRequired,
  isArray,
  scalarKind,
  enumValues,
  jsonStringLiteral,
  stringArrayLiteral,
  propertiesMapLiteral,
} from "./fr010-field-mapping.js";

/** Emit `{ format, rootName, style, fields: [ … ] } satisfies OutputFormatSpec`. */
export function specLiteral(vo: MetaData, template: MetaData, rootName: string): string {
  const formatEnum = resolveFormat(template);
  const styleEnum = resolvePromptStyle(template);
  const fieldLits = fields(vo).map(promptFieldLiteral);
  return (
    `{ format: ${formatEnum}, rootName: ${jsonStringLiteral(rootName)}, ` +
    `style: ${styleEnum}, fields: [${fieldLits.join(", ")}] } satisfies OutputFormatSpec`
  );
}

function resolveFormat(template: MetaData): string {
  const f = template.ownAttr(TEMPLATE_ATTR_FORMAT);
  return typeof f === "string" && f.toLowerCase() === "xml" ? "Format.XML" : "Format.JSON";
}

function resolvePromptStyle(template: MetaData): string {
  switch (template.ownAttr(TEMPLATE_ATTR_PROMPT_STYLE)) {
    case PROMPT_STYLE_INLINE:
      return "PromptStyle.INLINE";
    case PROMPT_STYLE_EXAMPLE_ONLY:
      return "PromptStyle.EXAMPLE_ONLY";
    default:
      return "PromptStyle.GUIDE";
  }
}

/** A PromptField object literal. Field order matches the PromptField interface. */
function promptFieldLiteral(field: MetaData): string {
  const name = jsonStringLiteral(field.name);
  const required = isRequired(field);
  const array = isArray(field);

  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    return (
      `{ name: ${name}, kind: FieldKind.OBJECT, required: ${required}, array: ${array}, ` +
      `enumValues: null, enumDoc: null, example: null, instruction: null, nested: null }` +
      ` /* FR-010: nested prompt deferred */`
    );
  }

  const example = optStringAttr(field, FIELD_ATTR_EXAMPLE);
  const instruction = optStringAttr(field, FIELD_ATTR_INSTRUCTION);

  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const valuesLit = stringArrayLiteral(enumValues(field));
    const enumDocLit = propertiesMapLiteral(field.ownAttr(FIELD_ATTR_ENUM_DOC));
    return (
      `{ name: ${name}, kind: FieldKind.ENUM, required: ${required}, array: ${array}, ` +
      `enumValues: ${valuesLit}, enumDoc: ${enumDocLit}, example: ${example}, ` +
      `instruction: ${instruction}, nested: null }`
    );
  }

  const kind = scalarKind(field.subType) ?? "STRING";
  return (
    `{ name: ${name}, kind: FieldKind.${kind}, required: ${required}, array: ${array}, ` +
    `enumValues: null, enumDoc: null, example: ${example}, instruction: ${instruction}, nested: null }`
  );
}

function optStringAttr(field: MetaData, attrName: string): string {
  const v = field.ownAttr(attrName);
  return typeof v === "string" ? jsonStringLiteral(v) : "null";
}
