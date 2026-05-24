// Zod validators template — emits InsertSchema (for create) and UpdateSchema (for update).
// Auto-generated PKs are EXCLUDED from InsertSchema (caller doesn't provide them).
// @autoSet fields: INSERT → .optional().transform(() => new Date().toISOString())
//                 UPDATE → onCreate fields omitted entirely; onUpdate gets same transform

import { code, imp, type Code } from "ts-poet";
import { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIME, FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_ENUM,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  FIELD_ATTR_AUTO_SET, AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE,
  VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_PATTERN,
  GENERATION_INCREMENT, GENERATION_UUID,
} from "@metaobjectsdev/metadata";
import { enumValues, zodEnumExpr } from "../enum-meta.js";
import { renderDocsFor } from "./jsdoc.js";

export function renderZodValidators(obj: MetaObject): Code {
  const z = imp("z@zod");
  const primary = obj.primaryIdentity();
  const autoGenPkFields = new Set<string>();
  if (primary) {
    const generation = primary.ownAttr(IDENTITY_ATTR_GENERATION);
    if (generation === GENERATION_INCREMENT || generation === GENERATION_UUID) {
      const fields = primary.ownAttr(IDENTITY_ATTR_FIELDS);
      const fieldsList = Array.isArray(fields) ? fields : (typeof fields === "string" ? [fields] : []);
      for (const f of fieldsList) autoGenPkFields.add(String(f));
    }
  }

  const insertFieldLines: string[] = [];
  const updateFieldLines: string[] = [];
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;

    const autoSet = child.ownAttr(FIELD_ATTR_AUTO_SET);

    // Insert schema: @autoSet fields use transform (always override client input).
    // NOTE: use "z" as a literal string here — these lines are embedded in the
    // `code` template tag below which resolves the imp("z@zod") import.
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        `  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      insertFieldLines.push(`  ${child.name}: ${zodFieldExpr(child)}`);
    }

    // Update schema: @autoSet onCreate → omit entirely; onUpdate → transform
    if (autoSet === AUTO_SET_ON_CREATE) {
      // Omit: creation timestamps cannot be changed after creation
    } else if (autoSet === AUTO_SET_ON_UPDATE) {
      updateFieldLines.push(
        `  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      // All non-autoSet fields are optional in the update schema (PATCH semantics)
      const expr = zodFieldExpr(child);
      const optionalExpr = expr.endsWith(".optional()") ? expr : `${expr}.optional()`;
      updateFieldLines.push(`  ${child.name}: ${optionalExpr}`);
    }
  }

  const insertSchemaName = `${obj.name}InsertSchema`;
  const updateSchemaName = `${obj.name}UpdateSchema`;

  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";

  return code`
${docsPrefix}export const ${insertSchemaName} = ${z}.object({
${insertFieldLines.join(",\n")}
});

${docsPrefix}export const ${updateSchemaName} = ${z}.object({
${updateFieldLines.join(",\n")}
});
`;
}

function zodFieldExpr(field: MetaField): string {
  let base: string;
  switch (field.subType) {
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_CURRENCY:
    case FIELD_SUBTYPE_LONG:
      base = "z.number().int()";
      break;
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      base = "z.number()";
      break;
    case FIELD_SUBTYPE_BOOLEAN:
      base = "z.boolean()";
      break;
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
      base = "z.string()";
      break;
    case FIELD_SUBTYPE_ENUM: {
      const values = enumValues(field);
      base = values !== undefined ? zodEnumExpr(values) : "z.string()";
      break;
    }
    case FIELD_SUBTYPE_STRING:
    default:
      base = "z.string()";
      break;
  }

  if (field.isArray) base = `z.array(${base})`;

  let isRequired = field.ownAttr(FIELD_ATTR_REQUIRED) === true;
  let maxLen: number | undefined = field.ownAttr(FIELD_ATTR_MAX_LENGTH) as number | undefined;
  let minLen: number | undefined;
  let pattern: string | undefined;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) isRequired = true;
    if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      const min = child.ownAttr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") maxLen = max;
      if (typeof min === "number") minLen = min;
    }
    if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const p = child.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof p === "string") pattern = p;
    }
  }

  let chain = base;
  if (field.subType === FIELD_SUBTYPE_STRING && !field.isArray) {
    if (minLen !== undefined) chain += `.min(${minLen})`;
    else if (isRequired) chain += `.min(1)`;
    if (maxLen !== undefined) chain += `.max(${maxLen})`;
    if (pattern !== undefined) chain += `.regex(new RegExp(${JSON.stringify(pattern)}))`;
  }

  // Fields with DB-level defaults are optional in the InsertSchema: the caller
  // can omit them and the DB will fill in. Otherwise required-with-default
  // would force callers to repeat the default at every call site.
  const hasDefault = field.ownAttr(FIELD_ATTR_DEFAULT) !== undefined;
  if (!isRequired || hasDefault) chain += `.optional()`;
  return chain;
}
