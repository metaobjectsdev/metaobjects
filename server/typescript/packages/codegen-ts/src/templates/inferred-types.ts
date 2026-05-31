// Inferred types template — emits Drizzle's InferSelectModel / InferInsertModel type aliases,
// plus named union types for field.enum fields.
//
// Also emits the structural TS interface for value-only objects (metaobjects
// with no writable source.rdb). That path side-steps Drizzle entirely: the
// interface is computed directly from the field tree, with `name?: T` for
// optional fields (matching Zod's `.optional()` inference — `T | undefined` —
// without the superfluous `| null` that Drizzle nullable columns introduce).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_UUID,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_OBJECT_REF,
} from "@metaobjectsdev/metadata";
import { variableNameFromEntity, toPascalCase } from "../naming.js";
import { enumValues } from "../enum-meta.js";
import { renderDocsFor } from "./jsdoc.js";

export function renderInferredTypes(entity: MetaObject): Code {
  const varName = variableNameFromEntity(entity.name);
  const selectSym = imp("InferSelectModel@drizzle-orm");
  const insertSym = imp("InferInsertModel@drizzle-orm");
  const docs = renderDocsFor(entity);
  const docsPrefix = docs ? `${docs}\n` : "";
  return code`
${docsPrefix}export type ${entity.name} = ${selectSym}<typeof ${varName}>;
export type ${entity.name}Insert = ${insertSym}<typeof ${varName}>;
export type ${entity.name}Update = Partial<${entity.name}Insert>;
`;
}

/**
 * Emit one `export type <Name> = "A" | "B";` line per field.enum field on the entity.
 * - If the field extends an abstract field.enum (super), use the super field's PascalCase name.
 * - Otherwise use `<Entity><FieldPascal>` for inline enums.
 * Returns null if the entity has no enum fields.
 */
export function renderEnumTypeAliases(entity: MetaObject): Code | null {
  // De-duplicate by type-alias name — multiple fields can extend the same abstract enum.
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const field of entity.fields()) {
    if (field.subType !== FIELD_SUBTYPE_ENUM) continue;

    const values = enumValues(field);
    if (values === undefined) continue;

    // Derive the type-alias name.
    const superField = field.resolveSuper();
    const typeName = superField !== undefined
      ? toPascalCase(superField.name)
      : `${entity.name}${toPascalCase(field.name)}`;

    if (seen.has(typeName)) continue;
    seen.add(typeName);

    const union = values.map((v) => JSON.stringify(v)).join(" | ");
    lines.push(`export type ${typeName} = ${union};`);
  }

  return lines.length > 0 ? code`${lines.join("\n")}` : null;
}

// ---------------------------------------------------------------------------
// Value-object interface emitter
// ---------------------------------------------------------------------------

const SCALAR_TS_BY_SUBTYPE: Record<string, string> = {
  [FIELD_SUBTYPE_STRING]: "string",
  [FIELD_SUBTYPE_CLASS]: "string",
  [FIELD_SUBTYPE_UUID]: "string",
  [FIELD_SUBTYPE_INT]: "number",
  [FIELD_SUBTYPE_SHORT]: "number",
  [FIELD_SUBTYPE_BYTE]: "number",
  [FIELD_SUBTYPE_LONG]: "number",
  [FIELD_SUBTYPE_DOUBLE]: "number",
  [FIELD_SUBTYPE_FLOAT]: "number",
  [FIELD_SUBTYPE_DECIMAL]: "number",
  [FIELD_SUBTYPE_CURRENCY]: "number",
  [FIELD_SUBTYPE_BOOLEAN]: "boolean",
  [FIELD_SUBTYPE_DATE]: "string",
  [FIELD_SUBTYPE_TIME]: "string",
  [FIELD_SUBTYPE_TIMESTAMP]: "string",
};

/** Type-alias name for a field.enum, mirroring renderEnumTypeAliases. */
function enumTypeAliasName(entity: MetaObject, field: MetaField): string {
  const superField = field.resolveSuper();
  return superField !== undefined
    ? toPascalCase(superField.name)
    : `${entity.name}${toPascalCase(field.name)}`;
}

/**
 * One-line TS type expression for a field on a value-only object.
 * Returns a `Code` so cross-module `field.object` refs can be hoisted via
 * ts-poet `imp(...)` — matching how the Zod emitter hoists `<Ref>InsertSchema`.
 */
function valueObjectFieldType(entity: MetaObject, field: MetaField): Code {
  // field.object: import the referenced TS interface from its sibling module
  // so ts-poet hoists the import. Mirrors zod-validators.ts's `<Ref>InsertSchema`
  // import strategy, just for the type alias instead of the schema constant.
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      const refImp = imp(`${ref}@./${ref}.js`);
      return field.isArray ? code`${refImp}[]` : code`${refImp}`;
    }
    return field.isArray ? code`unknown[]` : code`unknown`;
  }

  // field.enum: use the same type-alias name as renderEnumTypeAliases emits.
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    if (values !== undefined) {
      const alias = enumTypeAliasName(entity, field);
      return field.isArray ? code`${alias}[]` : code`${alias}`;
    }
    return field.isArray ? code`string[]` : code`string`;
  }

  const scalar = SCALAR_TS_BY_SUBTYPE[field.subType] ?? "unknown";
  return field.isArray ? code`${scalar}[]` : code`${scalar}`;
}

/**
 * Emit a structural `interface <Name> { ... }` for a value-only object.
 *
 * Optional fields use `name?: T` (matching the Zod `.optional()` inference
 * `T | undefined`) instead of `name?: T | null`. Value objects never round-
 * trip through Drizzle nullable columns, so the null-bridge is unnecessary
 * here — and forces consumers into a residual cast at the call site.
 */
export function renderValueObjectInterface(entity: MetaObject): Code {
  const docs = renderDocsFor(entity);
  const docsPrefix = docs ? `${docs}\n` : "";

  const lines: Code[] = [];
  for (const field of entity.fields()) {
    const required = field.ownAttr(FIELD_ATTR_REQUIRED) === true;
    const optional = required ? "" : "?";
    const tsType = valueObjectFieldType(entity, field);
    lines.push(code`  ${field.name}${optional}: ${tsType};`);
  }

  // joinCode with "\n" interpolates each Code segment on its own line and
  // keeps the imp() registrations intact so ts-poet hoists the imports.
  return code`${docsPrefix}export interface ${entity.name} {
${joinCode(lines, { on: "\n" })}
}
`;
}
