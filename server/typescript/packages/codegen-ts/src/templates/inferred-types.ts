// Inferred types template — emits Drizzle's InferSelectModel / InferInsertModel type aliases,
// plus named union types for field.enum fields.

import { code, imp, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { FIELD_SUBTYPE_ENUM } from "@metaobjectsdev/metadata";
import { variableNameFromEntity, toPascalCase } from "../naming.js";
import { enumValues } from "../enum-meta.js";
import { readDocAttrs, renderJsDocBlock } from "./jsdoc.js";

export function renderInferredTypes(entity: MetaObject): Code {
  const varName = variableNameFromEntity(entity.name);
  const selectSym = imp("InferSelectModel@drizzle-orm");
  const insertSym = imp("InferInsertModel@drizzle-orm");
  const docs = renderJsDocBlock(readDocAttrs(entity));
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
